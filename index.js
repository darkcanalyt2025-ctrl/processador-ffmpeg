const express = require('express');
const { exec } = require('child_process');
const fs = require('fs').promises;
const { BlobServiceClient } = require('@azure/storage-blob');

// Configuração do Servidor
const app = express();
app.use(express.json()); // Habilita o servidor a entender JSON
const port = process.env.PORT || 80; // O Azure Container Apps usa a porta 80

// Variável de ambiente do Azure
const AZURE_STORAGE_CONNECTION_STRING = process.env.AZURE_STORAGE_CONNECTION_STRING;

// Rota principal para o processamento
app.post('/', async (req, res) => {
  console.log('Processamento iniciado...');

  const { containerName, blobName, outputBlobName, resolution = '640:-1' } = req.body;

  if (!containerName || !blobName || !outputBlobName || !AZURE_STORAGE_CONNECTION_STRING) {
    console.error('Parâmetros faltando.');
    return res.status(400).send({ error: 'Parâmetros faltando.' });
  }

  const inputFilePath = `/tmp/${blobName}`;
  const outputFilePath = `/tmp/${outputBlobName}`;

  try {
    const blobServiceClient = BlobServiceClient.fromConnectionString(AZURE_STORAGE_CONNECTION_STRING);
    const containerClient = blobServiceClient.getContainerClient(containerName);

    console.log(`Baixando ${blobName}...`);
    await containerClient.getBlockBlobClient(blobName).downloadToFile(inputFilePath);

    const command = `ffmpeg -i "${inputFilePath}" -vf scale=${resolution} "${outputFilePath}"`;
    console.log(`Executando: ${command}`);

    await new Promise((resolve, reject) => {
      exec(command, (error, stdout, stderr) => {
        if (error) {
          console.error('Erro no FFmpeg:', stderr);
          return reject(new Error(stderr));
        }
        console.log('FFmpeg finalizado.');
        resolve();
      });
    });

    console.log(`Enviando ${outputBlobName}...`);
    await containerClient.getBlockBlobClient(outputBlobName).uploadFile(outputFilePath);

    console.log('Processo finalizado com sucesso.');
    res.status(200).send({ message: "Sucesso", outputBlob: outputBlobName });

  } catch (error) {
    console.error('Erro geral no processo:', error.message);
    res.status(500).send({ error: error.message });
  } finally {
    await fs.unlink(inputFilePath).catch(() => {});
    await fs.unlink(outputFilePath).catch(() => {});
  }
});

// Inicia o servidor
app.listen(port, () => {
  console.log(`Servidor rodando na porta ${port}`);
});
