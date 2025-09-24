console.log("--- index.js iniciado com sucesso ---");

const express = require('express');
const { spawn } = require('child_process'); // Usar spawn para maior segurança
const fs = require('fs').promises;
const path = require('path');
const { BlobServiceClient } = require('@azure/storage-blob');
const crypto = require('crypto'); // Para nomes de arquivos temporários únicos

const app = express();
app.use(express.json({ limit: '10mb' })); // Limite de 10MB para JSON payload
const port = process.env.PORT || 80;
const AZURE_STORAGE_CONNECTION_STRING = process.env.AZURE_STORAGE_CONNECTION_STRING;

// --- FUNÇÕES AUXILIARES ---

// Helper para executar comandos de forma segura com spawn (COM TIMEOUT)
const runSafeCommand = (command, args, timeoutMs = 120000) => { // 2 minutos default
  return new Promise((resolve, reject) => {
    console.log(`Executando: ${command} ${args.join(' ')}`);
    const child = spawn(command, args);
    let stdout = '';
    let stderr = '';

    // Timeout para evitar comandos que ficam "pendurados"
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Comando '${command}' timeout após ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        console.error('Erro no comando:', stderr);
        // Retorna o stderr completo se houver erro para melhor depuração
        return reject(new Error(stderr || `Comando '${command}' falhou com código ${code}`));
      }
      resolve(stdout.trim());
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      console.error('Falha ao iniciar o comando:', err);
      reject(err);
    });
  });
};

// Função OTIMIZADA para detectar dimensões da imagem usando ffprobe
const getImageDimensions = async (imagePath) => {
  try {
    // Comando mais rápido - só busca width,height em formato CSV
    const output = await runSafeCommand('ffprobe', [
      '-v', 'quiet',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height',
      '-of', 'csv=p=0',
      imagePath
    ], 15000); // 15 segundos timeout para detecção
    
    const [width, height] = output.split(',').map(Number);
    
    if (!width || !height) {
      throw new Error('Dimensões inválidas detectadas');
    }
    
    return {
      width: width,
      height: height,
      aspectRatio: width / height
    };
  } catch (error) {
    console.error('Erro ao obter dimensões da imagem:', error.message);
    console.warn('Usando dimensões padrão (1080x1920) devido a erro na detecção da imagem.');
    // Retornar valores padrão como fallback em caso de falha na detecção
    return { width: 1080, height: 1920, aspectRatio: 9/16 };
  }
};

// Função para determinar formato do vídeo baseado nas dimensões
const determineVideoFormat = (width, height) => {
  const aspectRatio = width / height;

  // Tolerância para variações pequenas na proporção
  const ASPECT_RATIO_TOLERANCE = 0.1;

  if (Math.abs(aspectRatio - (9/16)) < ASPECT_RATIO_TOLERANCE) {
    console.log('Formato detectado: Vertical (Shorts) - 1080x1920');
    return { width: 1080, height: 1920 };
  } else if (Math.abs(aspectRatio - (16/9)) < ASPECT_RATIO_TOLERANCE) {
    console.log('Formato detectado: Horizontal (Padrão) - 1920x1080');
    return { width: 1920, height: 1080 };
  } else if (Math.abs(aspectRatio - 1) < ASPECT_RATIO_TOLERANCE) {
    console.log('Formato detectado: Quadrado - 1080x1080');
    return { width: 1080, height: 1080 };
  } else {
    // Para proporções personalizadas, adapta para o mais próximo padrão
    if (aspectRatio < 1) { // Mais alto que largo (vertical)
      console.log(`Formato detectado: Vertical personalizado (${width}x${height}) - adaptando para 1080x1920`);
      return { width: 1080, height: 1920 };
    } else { // Mais largo que alto (horizontal)
      console.log(`Formato detectado: Horizontal personalizado (${width}x${height}) - adaptando para 1920x1080`);
      return { width: 1920, height: 1080 };
    }
  }
};

// Função para ajustar legendas para no máximo 2 linhas e comprimento razoável
async function sanitizeSrt(inputPath, outputPath) {
  const content = await fs.readFile(inputPath, "utf8");
  // Divide o arquivo SRT em blocos (número, timestamp, texto)
  const blocks = content.split(/\n\n/);

  const sanitizedBlocks = blocks.map(block => {
    const lines = block.split("\n");
    // Se o bloco tiver menos de 3 linhas (id, timecode, e uma ou nenhuma linha de texto), retorna como está
    if (lines.length < 3) return block;

    const [id, timecode, ...textLines] = lines;
    // Junta todas as linhas de texto em uma única string, remove espaços extras
    let text = textLines.join(" ").replace(/\s+/g, " ").trim();

    const words = text.split(" ");
    const newLines = [];
    let currentLine = "";

    const MAX_LINE_LENGTH = 45; // Máximo de caracteres por linha sugerido

    // Quebra o texto em linhas, tentando respeitar o MAX_LINE_LENGTH
    for (const word of words) {
      // Se adicionar a próxima palavra exceder o limite e a linha atual não estiver vazia,
      // finaliza a linha atual e começa uma nova com a palavra.
      if ((currentLine + " " + word).trim().length > MAX_LINE_LENGTH && currentLine.length > 0) {
        newLines.push(currentLine.trim());
        currentLine = word;
      } else {
        // Adiciona a palavra à linha atual
        currentLine += (currentLine ? " " : "") + word;
      }
    }
    if (currentLine) newLines.push(currentLine.trim()); // Adiciona a última linha

    // Garante que o texto tenha no máximo 2 linhas. Se tiver mais, recombina.
    let finalLines = newLines;
    if (newLines.length > 2) {
        const half = Math.ceil(newLines.length / 2);
        finalLines = [
            newLines.slice(0, half).join(" "), // Primeira metade
            newLines.slice(half).join(" ")     // Segunda metade
        ];
    } else if (newLines.length === 0) {
        // Caso o texto original estivesse vazio ou só com espaços
        finalLines = [""];
    }

    // Retorna o bloco de legenda formatado
    return [id, timecode, ...finalLines].join("\n");
  });

  // Escreve o conteúdo sanitizado de volta no arquivo de saída
  await fs.writeFile(outputPath, sanitizedBlocks.join("\n\n"), "utf8");
}

// --- ROTA PRINCIPAL DA API ---

app.post('/', async (req, res) => {
  console.log('Processo de montagem de vídeo iniciado (versão otimizada)...');
  const { cenas, musica, legenda, outputFile } = req.body;

  if (!cenas || !cenas.length || !outputFile || !AZURE_STORAGE_CONNECTION_STRING) {
    return res.status(400).send({ error: 'Parâmetros faltando: "cenas" (não pode ser vazia) e "outputFile" são obrigatórios, e "AZURE_STORAGE_CONNECTION_STRING" deve estar configurada.' });
  }

  const sanitizedOutputFileName = path.basename(outputFile);
  if (sanitizedOutputFileName !== outputFile) {
    return res.status(400).send({ error: 'Nome do arquivo de saída inválido.' });
  }
  if (!/\.(mp4|mov|webm|avi|mkv)$/i.test(sanitizedOutputFileName)) {
    return res.status(400).send({ error: 'O arquivo de saída deve ter uma extensão de vídeo válida (ex: .mp4).' });
  }

  const blobServiceClient = BlobServiceClient.fromConnectionString(AZURE_STORAGE_CONNECTION_STRING);
  const containerClient = blobServiceClient.getContainerClient('videos');
  const tempDir = path.join('/tmp', crypto.randomUUID());
  await fs.mkdir(tempDir, { recursive: true });

  const tempFileMap = new Map();

  try {
    // --- PASSO 1: BAIXAR TODOS OS ARQUIVOS (sem alteração) ---
    console.log('Baixando arquivos...');
    const filesToProcess = [];
    cenas.forEach((cena) => {
      filesToProcess.push({ type: 'image', originalName: cena.imagem });
      filesToProcess.push({ type: 'audio', originalName: cena.narracao });
    });
    if (musica) filesToProcess.push({ type: 'music', originalName: musica });
    if (legenda) filesToProcess.push({ type: 'subtitle', originalName: legenda });

    const downloadPromises = filesToProcess.map(async (fileInfo) => {
      const tempFileName = `${crypto.randomUUID()}${path.extname(fileInfo.originalName) || '.tmp'}`;
      const localPath = path.join(tempDir, tempFileName);
      tempFileMap.set(fileInfo.originalName, localPath);
      await containerClient.getBlockBlobClient(fileInfo.originalName).downloadToFile(localPath);
      console.log(` - Baixado: ${fileInfo.originalName}`);
    });
    await Promise.all(downloadPromises);

    // --- PASSO 2: ANALISAR DURAÇÕES E FORMATO (sem alteração) ---
    console.log('Analisando duração das narrações e formato...');
    const sceneDurations = await Promise.all(cenas.map(async (cena) => {
      const audioPath = tempFileMap.get(cena.narracao);
      const duration = await runSafeCommand('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', audioPath]);
      return parseFloat(duration);
    }));
    
    const firstImagePath = tempFileMap.get(cenas[0].imagem);
    const dimensions = await getImageDimensions(firstImagePath);
    const videoFormat = determineVideoFormat(dimensions.width, dimensions.height);


    // --- NOVO PASSO 3: CRIAR CLIPES INDIVIDUAIS PARA CADA CENA ---
    console.log('Etapa 1/3: Criando clipes de vídeo individuais...');
    const clipPaths = []; // Array para guardar os caminhos dos clipes gerados
    
    for (const [index, cena] of cenas.entries()) {
      const imagePath = tempFileMap.get(cena.imagem);
      const audioPath = tempFileMap.get(cena.narracao);
      const duration = sceneDurations[index];
      const clipOutputPath = path.join(tempDir, `clip_${index}.mp4`);

      console.log(` - Criando clipe ${index + 1}/${cenas.length}...`);

      const ffmpegArgs = [
        '-loop', '1',
        '-i', imagePath,
        '-i', audioPath,
        '-t', duration.toString(),
        '-vf', `scale=${videoFormat.width}:${videoFormat.height}:force_original_aspect_ratio=decrease,pad=${videoFormat.width}:${videoFormat.height}:(ow-iw)/2:(oh-ih)/2,setsar=1`,
        '-c:v', 'libx264',
        '-c:a', 'aac',
        '-pix_fmt', 'yuv420p',
        '-shortest',
        '-y',
        clipOutputPath
      ];

      await runSafeCommand('ffmpeg', ffmpegArgs, 180000); // 3 min timeout por clipe
      clipPaths.push(clipOutputPath);
    }


    // --- NOVO PASSO 4: CONCATENAR TODOS OS CLIPES ---
    console.log('Etapa 2/3: Concatenando clipes...');
    const concatListPath = path.join(tempDir, 'concat_list.txt');
    const concatContent = clipPaths.map(p => `file '${p}'`).join('\n');
    await fs.writeFile(concatListPath, concatContent);

    const concatenatedVideoPath = path.join(tempDir, 'concatenated.mp4');
    const concatArgs = [
      '-f', 'concat',
      '-safe', '0',
      '-i', concatListPath,
      '-c', 'copy', // <-- A mágica da eficiência está aqui!
      '-y',
      concatenatedVideoPath
    ];
    
    await runSafeCommand('ffmpeg', concatArgs, 60000); // 1 min timeout para concatenar


    // --- NOVO PASSO 5: ADICIONAR MÚSICA DE FUNDO E LEGENDAS ---
    console.log('Etapa 3/3: Adicionando música e legendas...');
    let finalVideoPath = concatenatedVideoPath;
    let inputs = ['-i', concatenatedVideoPath];
    let filterComplex = [];
    let mapArgs = [];

    // Lógica para adicionar música e/ou legendas
    if (musica || legenda) {
      const finalOutputPath = path.join(tempDir, sanitizedOutputFileName);
      let videoInputMap = '[0:v]';
      let audioInputMap = '[0:a]';
      let streamIndex = 1;

      if (musica) {
        inputs.push('-i', tempFileMap.get(musica));
        filterComplex.push(`[${streamIndex}:a]volume=0.2[a_musica]`);
        filterComplex.push(`[${audioInputMap}][a_musica]amix=inputs=2:duration=first[a_out]`);
        audioInputMap = '[a_out]';
        streamIndex++;
      }

      if (legenda) {
        const originalLegendaPath = tempFileMap.get(legenda);
        const legendaSanitizedPath = path.join(tempDir, 'legendas_formatadas.srt');
        await sanitizeSrt(originalLegendaPath, legendaSanitizedPath);
        const escapedLegendaPath = legendaSanitizedPath.replace(/\\/g, '\\\\').replace(/:/g, '\\:');
        filterComplex.push(`${videoInputMap}subtitles='${escapedLegendaPath}:force_style=Fontsize=28,MarginV=60,Alignment=2'[v_out]`);
        videoInputMap = '[v_out]';
      }

      mapArgs.push('-map', videoInputMap, '-map', audioInputMap);
      
      const finalArgs = [
        ...inputs,
        '-filter_complex', filterComplex.join(';'),
        ...mapArgs,
        '-c:v', 'libx264',
        '-c:a', 'aac',
        '-pix_fmt', 'yuv420p',
        '-y',
        finalOutputPath
      ];

      await runSafeCommand('ffmpeg', finalArgs, 240000); // 4 min timeout para finalização
      finalVideoPath = finalOutputPath;
    } else {
        // Se não houver música ou legenda, o vídeo concatenado já é o final
        finalVideoPath = path.join(tempDir, sanitizedOutputFileName);
        await fs.rename(concatenatedVideoPath, finalVideoPath);
    }
    

    // --- PASSO 6: ENVIAR O VÍDEO FINAL PARA O AZURE (sem alteração) ---
    console.log(`Enviando ${sanitizedOutputFileName} para o Azure Blob Storage...`);
    await containerClient.getBlockBlobClient(sanitizedOutputFileName).uploadFile(finalVideoPath);
    console.log(`Vídeo ${sanitizedOutputFileName} enviado com sucesso.`);

    res.status(200).send({ 
      message: "Vídeo montado com sucesso!", 
      outputFile: sanitizedOutputFileName,
      resolution: `${videoFormat.width}x${videoFormat.height}`
    });

  } catch (error) {
    console.error('Erro geral na montagem do vídeo:', error);
    res.status(500).send({ error: `Erro na montagem: ${error.message}` });
  } finally {
    // --- PASSO 7: LIMPAR ARQUIVOS TEMPORÁRIOS (sem alteração) ---
    console.log('Limpando arquivos temporários...');
    try {
        await fs.rm(tempDir, { recursive: true, force: true });
        console.log(`Diretório temporário ${tempDir} e seus conteúdos removidos.`);
    } catch (cleanError) {
        console.error(`Erro ao limpar o diretório temporário ${tempDir}:`, cleanError);
    }
  }
});
