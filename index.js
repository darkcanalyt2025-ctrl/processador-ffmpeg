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
  console.log('Processo de montagem de vídeo iniciado...');
  const { cenas, musica, legenda, outputFile } = req.body;

  // Validação inicial dos parâmetros obrigatórios
  if (!cenas || !cenas.length || !outputFile || !AZURE_STORAGE_CONNECTION_STRING) {
    return res.status(400).send({ error: 'Parâmetros faltando: "cenas" (não pode ser vazia) e "outputFile" são obrigatórios, e "AZURE_STORAGE_CONNECTION_STRING" deve estar configurada.' });
  }

  // --- VALIDAÇÃO E SANITIZAÇÃO DE ENTRADAS ---
  // Garante que o nome do arquivo de saída não contenha caminhos ou caracteres maliciosos
  const sanitizedOutputFileName = path.basename(outputFile);
  if (sanitizedOutputFileName !== outputFile) {
    return res.status(400).send({ error: 'Nome do arquivo de saída inválido: não pode conter caminhos relativos ou absolutos.' });
  }
  // Garante uma extensão de vídeo válida para o arquivo de saída
  if (!/\.(mp4|mov|webm|avi|mkv)$/i.test(sanitizedOutputFileName)) {
    return res.status(400).send({ error: 'O arquivo de saída deve ter uma extensão de vídeo válida (ex: .mp4, .mov, .webm).' });
  }

  // --- CONFIGURAÇÃO DO AZURE BLOB STORAGE E DIRETÓRIO TEMPORÁRIO ---
  const blobServiceClient = BlobServiceClient.fromConnectionString(AZURE_STORAGE_CONNECTION_STRING);
  const containerClient = blobServiceClient.getContainerClient('videos'); // Container padrão 'videos'

  // Cria um diretório temporário único para cada requisição para isolamento e limpeza fácil
  const tempDir = path.join('/tmp', crypto.randomUUID());
  await fs.mkdir(tempDir, { recursive: true });

  const tempFileMap = new Map(); // Mapeia o nome original do blob para o caminho temporário local

  try {
    // --- PASSO 1: BAIXAR TODOS OS ARQUIVOS NECESSÁRIOS EM PARALELO ---
    console.log('Baixando arquivos...');
    const filesToProcess = [];

    // Adiciona todas as referências de arquivos (imagens, narrações, música, legenda)
    cenas.forEach((cena) => {
      filesToProcess.push({ type: 'image', originalName: cena.imagem });
      filesToProcess.push({ type: 'audio', originalName: cena.narracao });
    });
    if (musica) filesToProcess.push({ type: 'music', originalName: musica });
    if (legenda) filesToProcess.push({ type: 'subtitle', originalName: legenda });

    // Baixa todos os arquivos em paralelo para melhorar a performance
    // OTIMIZAÇÃO: Adicionar timeout e limite de concorrência
    const downloadPromises = filesToProcess.map(async (fileInfo) => {
      const originalExt = path.extname(fileInfo.originalName);
      // Cria um nome de arquivo temporário único com a extensão original (ou uma padrão)
      const tempFileName = `${crypto.randomUUID()}${originalExt || (fileInfo.type === 'image' ? '.jpg' : fileInfo.type === 'audio' || fileInfo.type === 'music' ? '.mp3' : '.bin')}`;
      const localPath = path.join(tempDir, tempFileName);

      // Salva o mapeamento do nome original do blob para o caminho temporário local
      tempFileMap.set(fileInfo.originalName, localPath);

      const downloadPromise = containerClient.getBlockBlobClient(fileInfo.originalName).downloadToFile(localPath);
      
      // Timeout de 60 segundos para cada download
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error(`Timeout no download de ${fileInfo.originalName}`)), 60000)
      );

      await Promise.race([downloadPromise, timeoutPromise]);
      console.log(` - Baixado: ${fileInfo.originalName} para ${localPath}`);
    });

    await Promise.all(downloadPromises);

    // --- PASSO 2: ANALISAR DURAÇÃO DAS NARRAÇÕES ---
    console.log('Analisando duração das narrações...');
    const sceneDurations = [];
    for (const cena of cenas) {
      const audioPath = tempFileMap.get(cena.narracao);
      if (!audioPath) throw new Error(`Caminho da narração não encontrado para ${cena.narracao}`);

      const duration = await runSafeCommand('ffprobe', [
        '-v', 'error', // Suprime mensagens de erro verbosas
        '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1', // Formato de saída limpo
        audioPath
      ], 30000); // 30 segundos timeout para análise de duração
      
      sceneDurations.push(parseFloat(duration));
      console.log(` - Duração de ${cena.narracao}: ${duration}s`);
    }

    // --- PASSO 2.5: DETECTAR RESOLUÇÃO E FORMATO DO VÍDEO COM TIMEOUT ---
    console.log('Detectando resolução da primeira imagem para determinar o formato do vídeo...');
    const firstImagePath = tempFileMap.get(cenas[0].imagem);
    if (!firstImagePath) throw new Error('Caminho da primeira imagem não encontrado.');
    
    let videoFormat = { width: 1080, height: 1920 }; // Default fallback
    try {
      // Timeout de 20 segundos para detecção de dimensões
      const dimensionsPromise = getImageDimensions(firstImagePath);
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Timeout na detecção de dimensões')), 20000)
      );
      
      const dimensions = await Promise.race([dimensionsPromise, timeoutPromise]);
      videoFormat = determineVideoFormat(dimensions.width, dimensions.height);
    } catch (error) {
      console.log(`Erro na detecção automática: ${error.message}`);
      console.log('Usando formato padrão: Vertical (Shorts) - 1080x1920');
    }

    // --- PASSO 3: CONSTRUIR E EXECUTAR O COMANDO FFmpeg ---
    console.log('Construindo comando FFmpeg...');
    let inputs = []; // Array para os argumentos de entrada do FFmpeg
    let filterComplexParts = []; // Array para as partes do filtro complexo
    let streamIndex = 0; // Índice global para os streams de entrada do FFmpeg

    // Adiciona inputs para cada cena (imagem em loop e áudio de narração)
    for (let i = 0; i < cenas.length; i++) {
      const cena = cenas[i];
      const duration = sceneDurations[i];
      const imagePath = tempFileMap.get(cena.imagem);
      const audioPath = tempFileMap.get(cena.narracao);

      if (!imagePath || !audioPath) throw new Error(`Caminhos de imagem ou áudio não encontrados para cena ${i}.`);

      inputs.push('-loop', '1', '-t', duration.toString(), '-i', imagePath); // Imagem em loop
      inputs.push('-i', audioPath); // Áudio da narração

      // Escala e pad a imagem para o formato final, então combina com o áudio
      filterComplexParts.push(
        `[${streamIndex}:v]scale=${videoFormat.width}:${videoFormat.height}:force_original_aspect_ratio=decrease,` +
        `pad=${videoFormat.width}:${videoFormat.height}:(ow-iw)/2:(oh-ih)/2,setsar=1[v${i}]`
      );
      streamIndex++; // Incrementa para o próximo stream de entrada (áudio da narração)
      filterComplexParts.push(`[${streamIndex}:a]anull[a${i}]`); // Passa o áudio da narração sem modificação
      streamIndex++; // Incrementa para o próximo stream de entrada
    }

    // Concatena todos os segmentos de vídeo e áudio juntos
    const concatParts = cenas.map((_, i) => `[v${i}][a${i}]`).join('');
    filterComplexParts.push(`${concatParts}concat=n=${cenas.length}:v=1:a=1[v_concat][a_narracao]`);

    let finalAudioMap = "[a_narracao]"; // Stream de áudio final, inicialmente apenas a narração
    // Adiciona música de fundo se fornecida
    if (musica) {
      const musicPath = tempFileMap.get(musica);
      if (!musicPath) throw new Error(`Caminho da música não encontrado para ${musica}`);

      inputs.push('-stream_loop', '-1', '-i', musicPath); // Música em loop infinito
      filterComplexParts.push(`[${streamIndex}:a]volume=0.2[a_musica]`); // Reduz o volume da música
      filterComplexParts.push(`[a_narracao][a_musica]amix=inputs=2:duration=first[a_mix]`); // Mixa narração com música
      finalAudioMap = "[a_mix]";
      streamIndex++;
    }

    let finalVideoMap = "[v_concat]"; // Stream de vídeo final, inicialmente apenas o concatenado
    // Adiciona legendas se fornecidas
    if (legenda) {
      const originalLegendaPath = tempFileMap.get(legenda);
      if (!originalLegendaPath) throw new Error(`Caminho da legenda não encontrado para ${legenda}`);

      // Cria um caminho temporário único para a legenda sanitizada
      const legendaSanitizedPath = path.join(tempDir, `legendas_formatadas_${crypto.randomUUID()}.srt`);

      // Sanitiza o arquivo SRT
      await sanitizeSrt(originalLegendaPath, legendaSanitizedPath);

      // Adiciona o filtro de legendas
      // Escapa caracteres especiais no caminho do arquivo para o FFmpeg
      const escapedLegendaPath = legendaSanitizedPath.replace(/\\/g, '\\\\').replace(/:/g, '\\:');
      filterComplexParts.push(
        `[v_concat]subtitles='${escapedLegendaPath}:force_style=Fontsize=28,MarginV=60,Alignment=2'[v_legendado]`
      );
      finalVideoMap = "[v_legendado]";
    }

    // Caminho de saída final no diretório temporário
    const outputPath = path.join(tempDir, sanitizedOutputFileName);
    const filterComplexString = filterComplexParts.join('; ');

    // Monta todos os argumentos para o comando FFmpeg
    const ffmpegArgs = [
        ...inputs,
        '-filter_complex', filterComplexString,
        '-map', finalVideoMap,
        '-map', finalAudioMap,
        '-c:v', 'libx264',      // Codec de vídeo H.264
        '-c:a', 'aac',          // Codec de áudio AAC
        '-pix_fmt', 'yuv420p',  // Formato de pixel (compatibilidade ampla)
        '-y',                   // Sobrescreve o arquivo de saída se existir
        outputPath
    ];

    // Executa o comando FFmpeg com timeout estendido
    console.log('Executando processamento FFmpeg...');
    await runSafeCommand('ffmpeg', ffmpegArgs, 300000); // 5 minutos timeout para FFmpeg

    // --- PASSO 4: ENVIAR O VÍDEO FINAL PARA O AZURE BLOB STORAGE ---
    console.log(`Enviando ${sanitizedOutputFileName} para o Azure Blob Storage...`);
    await containerClient.getBlockBlobClient(sanitizedOutputFileName).uploadFile(outputPath);
    console.log(`Vídeo ${sanitizedOutputFileName} enviado com sucesso.`);

    // Responde ao cliente com sucesso
    res.status(200).send({ 
      message: "Vídeo montado com sucesso!", 
      outputFile: sanitizedOutputFileName,
      resolution: `${videoFormat.width}x${videoFormat.height}`
    });

  } catch (error) {
    // Tratamento de erros
    console.error('Erro geral na montagem do vídeo:', error);
    res.status(500).send({ error: `Erro na montagem: ${error.message}` });
  } finally {
    // --- PASSO 5: LIMPAR ARQUIVOS TEMPORÁRIOS ---
    console.log('Limpando arquivos temporários...');
    try {
        // Remove o diretório temporário completo de forma recursiva e forçada
        await fs.rm(tempDir, { recursive: true, force: true });
        console.log(`Diretório temporário ${tempDir} e seus conteúdos removidos.`);
    } catch (cleanError) {
        console.error(`Erro ao limpar o diretório temporário ${tempDir}:`, cleanError);
    }
  }
});

// --- INICIA O SERVIDOR ---
app.listen(port, () => {
  console.log(`Servidor de montagem de vídeo rodando na porta ${port}`);
});
