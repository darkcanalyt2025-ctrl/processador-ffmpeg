const { exec } = require('child_process');
const fs = require('fs').promises;
const { BlobServiceClient } = require('@azure/storage-blob');
const AZURE_STORAGE_CONNECTION_STRING = process.env.AZURE_STORAGE_CONNECTION_STRING;

module.exports = async function (context, req) {
    context.log('FFmpeg processing function triggered.');
    const { containerName, blobName, outputBlobName, resolution = '640:-1' } = req.body;
    if (!containerName || !blobName || !outputBlobName || !AZURE_STORAGE_CONNECTION_STRING) {
        return context.res = { status: 400, body: 'Missing required parameters.' };
    }
    const inputFilePath = `/tmp/${blobName}`;
    const outputFilePath = `/tmp/${outputBlobName}`;
    try {
        const blobServiceClient = BlobServiceClient.fromConnectionString(AZURE_STORAGE_CONNECTION_STRING);
        const containerClient = blobServiceClient.getContainerClient(containerName);
        context.log(`Downloading ${blobName}...`);
        await containerClient.getBlockBlobClient(blobName).downloadToFile(inputFilePath);
        const command = `ffmpeg -i ${inputFilePath} -vf scale=${resolution} ${outputFilePath}`;
        context.log(`Executing: ${command}`);
        await new Promise((resolve, reject) => {
            exec(command, (error, stdout, stderr) => {
                if (error) { context.log.error(stderr); return reject(error); }
                resolve();
            });
        });
        context.log(`Uploading ${outputBlobName}...`);
        await containerClient.getBlockBlobClient(outputBlobName).uploadFile(outputFilePath);
        context.res = { status: 200, body: { message: "Success", outputBlob: outputBlobName } };
    } catch (error) {
        context.log.error(error);
        context.res = { status: 500, body: `Error: ${error.message}` };
    } finally {
        await fs.unlink(inputFilePath).catch(() => {});
        await fs.unlink(outputFilePath).catch(() => {});
    }
};
