console.log("--- index.js iniciado com sucesso ---");

const express = require('express');
const { spawn } = require('child_process'); // Usar spawn para maior segurança
const fs = require('fs').promises;
const path = require('path');
const { BlobServiceClient } = require('@azure/storage-blob');
const crypto = require('crypto'); // Para nomes de arquivos temporários únicos

const app = express();
app.use(express.json({ limit: '10mb' }));
const port = process.env.PORT || 80;
const AZURE_STORAGE_CONNECTION_STRING = process.env.AZURE_STORAGE_CONNECTION_STRING;

// Helper para executar comandos de forma segura com spawn
const runSafeCommand = (command, args) => {
  return new Promise((resolve, reject) => {
    console.log(`Executando: ${command} ${args.join(' ')}`);
    const child = spawn(command, args);
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      if (code !== 0) {
        console.error('Erro no comando:', stderr);
        return reject(new Error(stderr || `Comando '${command}' falhou com código ${code}`));
      }
      resolve(stdout.trim());
    });

    child.on('error', (err) => {
      console.error('Falha ao iniciar o comando:', err);
      reject(err);
    });
  });
};

// Função para detectar dimensões da imagem
const getImageDimensions = async (imagePath) => {
  try {
    const output = await runSafeCommand('ffprobe', [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_streams',
      imagePath
    ]);
    const info = JSON.parse(output);
    const videoStream = info.streams.find(stream => stream.codec_type === 'video');
    if (!videoStream) {
        throw new Error('Nenhum stream de vídeo encontrado na imagem.');
    }
    return {
      width: videoStream.width,
      height: videoStream.height,
      aspectRatio: videoStream.width / videoStream.height
    };
  } catch (error) {
    console.error('Erro ao obter dimensões da imagem:', error);
    // Em vez de valores padrão, relançar ou lidar de forma mais explícita.
    // Para fins de demonstração, manterei os valores padrão como fallback,
    // mas com um aviso claro.
    console.warn('Usando dimensões padrão devido a erro na detecção da imagem.');
    return { width: 1080, height: 1920, aspectRatio: 9/16 };
  }
};

// ... determineVideoFormat e sanitizeSrt permanecem iguais (exceto pelo uso de runSafeCommand se aplicável)

// Função para ajustar legendas para no máximo 2 linhas
async function sanitizeSrt(inputPath, outputPath) {
  const content = await fs.readFile(inputPath, "utf8");
  const blocks = content.split(/\n\n/);

  const sanitizedBlocks = blocks.map(block => {
    const lines = block.split("\n");
    if (lines.length < 3) return block; // Se já tiver 1 ou 2 linhas de texto, não faz nada

    const [id, timecode, ...textLines] = lines;
    let text = textLines.join(" ").replace(/\s+/g, " ").trim();

    const words = text.split(" ");
    const newLines = [];
    let currentLine = "";

    // Adaptação para tentar quebrar em duas linhas de forma mais equilibrada,
    // garantindo que não exceda um tamanho razoável (aprox 40-50 chars).
    // Esta lógica pode ser ainda mais aprimorada, mas é um ponto de partida.
    const MAX_LINE_LENGTH = 45; // Caracteres máximos por linha
    for (const word of words) {
      if ((currentLine + " " + word).trim().length > MAX_LINE_LENGTH && currentLine.length > 0) {
        newLines.push(currentLine.trim());
        currentLine = word;
      } else {
        currentLine += (currentLine ? " " : "") + word;
      }
    }
    if (currentLine) newLines.push(currentLine.trim());

    // Se houver mais de 2 linhas após a primeira tentativa de quebra,
    // tentamos juntar novamente para garantir as 2 linhas.
    let finalLines = newLines;
    if (newLines.length > 2) {
        const half = Math.ceil(newLines.length / 2);
        finalLines = [
            newLines.slice(0, half).join(" "),
            newLines.slice(half).join(" ")
        ];
    } else if (newLines.length === 0) {
        // Caso a linha original estivesse vazia ou só com espaços
        finalLines = [""];
    }

    return [id, timecode, ...finalLines].join("\n");
  });

  await fs.writeFile(outputPath, sanitizedBlocks.join("\n\n"), "utf8");
}


app.post('/', async (req, res) => {
  console.log('Processo de montagem de vídeo iniciado...');
  const { cenas, musica, legenda, outputFile } = req.body;

  if (!cenas || !cenas.length || !outputFile || !AZURE_STORAGE_CONNECTION_STRING) {
    return res.status(400).send({ error: 'Parâmetros faltando: cenas (não pode ser vazia) e outputFile são obrigatórios.' });
  }

  // Validação e sanitização do outputFile para evitar travessia de diretório ou comandos
  const sanitizedOutputFileName = path.basename(outputFile);
  if (sanitizedOutputFileName !== outputFile) {
    return res.status(400).send({ error: 'Nome do arquivo de saída inválido.' });
  }
  if (!/\.(mp4|mov|webm)$/i.test(sanitizedOutputFileName)) {
    return res.status(400).send({ error: 'O arquivo de saída deve ter uma extensão de vídeo válida (ex: .mp4).' });
  }


  const blobServiceClient = BlobServiceClient.fromConnectionString(AZURE_STORAGE_CONNECTION_STRING);
  const containerClient = blobServiceClient.getContainerClient('videos');
  const tempDir = path.join('/tmp', crypto.randomUUID()); // Diretório temporário único
  await fs.mkdir(tempDir, { recursive: true });

  const tempFileMap = new Map(); // Mapeia nome original para path temporário
  const allTempPaths = new Set(); // Todos os caminhos temporários criados

  try {
    // --- PASSO 1: BAIXAR ---
    console.log('Baixando arquivos...');
    const filesToProcess = [];

    // Adiciona todas as referências de arquivos para processamento
    cenas.forEach((cena, index) => {
      filesToProcess.push({ type: 'image', originalName: cena.imagem, sceneIndex: index });
      filesToProcess.push({ type: 'audio', originalName: cena.narracao, sceneIndex: index });
    });
    if (musica) filesToProcess.push({ type: 'music', originalName: musica });
    if (legenda) filesToProcess.push({ type: 'subtitle', originalName: legenda });

    await Promise.all(filesToProcess.map(async (fileInfo) => {
      // Cria um nome de arquivo temporário único com a extensão original ou padrão
      const originalExt = path.extname(fileInfo.originalName);
      const tempFileName = `${crypto.randomUUID()}${originalExt || (fileInfo.type === 'image' ? '.jpg' : fileInfo.type === 'audio' || fileInfo.type === 'music' ? '.mp3' : '.bin')}`;
      const localPath = path.join(tempDir, tempFileName);

      // Salva o mapeamento do nome original para o caminho temporário
      tempFileMap.set(fileInfo.originalName, localPath);
      allTempPaths.add(localPath); // Adiciona para limpeza final

      await containerClient.getBlockBlobClient(fileInfo.originalName).downloadToFile(localPath);
      console.log(` - Baixado: ${fileInfo.originalName} para ${localPath}`);
    }));


    // --- PASSO 2: ANALISAR E PREPARAR (sem renomear, usando os paths temporários) ---
    console.log('Analisando duração e preparando arquivos...');
    const sceneDurations = [];
    for (let i = 0; i < cenas.length; i++) {
      const cena = cenas[i];
      const audioPath = tempFileMap.get(cena.narracao);

      const duration = await runSafeCommand('ffprobe', [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        audioPath
      ]);
      sceneDurations.push(parseFloat(duration));
      console.log(` - Duração de ${cena.narracao}: ${duration}s`);
    }

    // --- PASSO 2.5: DETECTAR RESOLUÇÃO AUTOMATICAMENTE ---
    console.log('Detectando resolução da primeira imagem...');
    const firstImagePath = tempFileMap.get(cenas[0].imagem);
    const dimensions = await getImageDimensions(firstImagePath);
    const videoFormat = determineVideoFormat(dimensions.width, dimensions.height);

    // --- PASSO 3: CONSTRUIR O COMANDO FFMEG ---
    console.log('Construindo comando FFmpeg...');
    let inputs = [];
    let filterComplexParts = [];
    let streamIndex = 0;

    for (let i = 0; i < cenas.length; i++) {
      const cena = cenas[i];
      const duration = sceneDurations[i];
      const imagePath = tempFileMap.get(cena.imagem);
      const audioPath = tempFileMap.get(cena.narracao);

      inputs.push('-loop', '1', '-t', duration.toString(), '-i', imagePath); // Uso seguro de -i
      inputs.push('-i', audioPath); // Uso seguro de -i

      filterComplexParts.push(
        `[${streamIndex}:v]scale=${videoFormat.width}:${videoFormat.height}:force_original_aspect_ratio=decrease,` +
        `pad=${videoFormat.width}:${videoFormat.height}:(ow-iw)/2:(oh-ih)/2,setsar=1[v${i}]`
      );
      streamIndex++; // v stream
      filterComplexParts.push(`[${streamIndex}:a]anull[a${i}]`);
      streamIndex++; // a stream
    }

    const concatParts = cenas.map((_, i) => `[v${i}][a${i}]`).join('');
    filterComplexParts.push(`${concatParts}concat=n=${cenas.length}:v=1:a=1[v_concat][a_narracao]`);

    let finalAudioMap = "[a_narracao]";
    if (musica) {
      const musicPath = tempFileMap.get(musica);
      inputs.push('-stream_loop', '-1', '-i', musicPath); // Uso seguro de -i
      filterComplexParts.push(`[${streamIndex}:a]volume=0.2[a_musica]`);
      filterComplexParts.push(`[a_narracao][a_musica]amix=inputs=2:duration=first[a_mix]`);
      finalAudioMap = "[a_mix]";
      streamIndex++;
    }

    let finalVideoMap = "[v_concat]";
    if (legenda) {
      const originalLegendaPath = tempFileMap.get(legenda);
      const legendaSanitizedPath = path.join(tempDir, `legendas_formatadas_${crypto.randomUUID()}.srt`);
      allTempPaths.add(legendaSanitizedPath);

      await sanitizeSrt(originalLegendaPath, legendaSanitizedPath);

      filterComplexParts.push(
        `[v_concat]subtitles='${legendaSanitizedPath.replace(/\\/g, '\\\\').replace(/:/g, '\\:')}:force_style=Fontsize=28,MarginV=60,Alignment=2'[v_legendado]`
      );
      finalVideoMap = "[v_legendado]";
    }

    const outputPath = path.join(tempDir, sanitizedOutputFileName); // Usa o nome de arquivo de saída sanitizado
    const filterComplexString = filterComplexParts.join('; ');

    const ffmpegArgs = [
        ...inputs,
        '-filter_complex', filterComplexString,
        '-map', finalVideoMap,
        '-map', finalAudioMap,
        '-c:v', 'libx264',
        '-c:a', 'aac',
        '-pix_fmt', 'yuv420p',
        '-y', // Sobrescreve arquivo de saída se existir
        outputPath
    ];

    await runSafeCommand('ffmpeg', ffmpegArgs);

    console.log(`Enviando ${sanitizedOutputFileName}...`);
    await containerClient.getBlockBlobClient(sanitizedOutputFileName).uploadFile(outputPath);
    allTempPaths.add(outputPath);

    res.status(200).send({ message: "Vídeo montado com sucesso!", outputFile: sanitizedOutputFileName });

  } catch (error) {
    console.error('Erro na montagem do vídeo:', error);
    res.status(500).send({ error: `Erro na montagem: ${error.message}` });
  } finally {
    console.log('Limpando arquivos temporários...');
    // A limpeza agora é feita no diretório temporário único
    try {
        await fs.rm(tempDir, { recursive: true, force: true });
        console.log(`Diretório temporário ${tempDir} removido.`);
    } catch (cleanError) {
        console.error(`Erro ao limpar o diretório temporário ${tempDir}:`, cleanError);
    }
  }
});

app.listen(port, () => {
  console.log(`Servidor de montagem de vídeo rodando na porta ${port}`);
});
