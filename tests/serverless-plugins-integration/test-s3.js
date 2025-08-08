const {Writable} = require('stream');
const {spawn} = require('child_process');
const Minio = require('minio');
const onExit = require('signal-exit');
const pump = require('pump');
const {delay, getSplitLinesTransform} = require('./utils');

const EXPECTED_LAMBDA_CALL = 7;
const PATH = './files/test.txt';

const client = new Minio.Client({
  region: 'eu-west-1',
  endPoint: 'localhost',
  port: 9000,
  accessKey: 'local',
  secretKey: 'locallocal',
  useSSL: false
});

const uploadFiles = async () => {
  await delay(1000);

  await client.fPutObject('documents', 'first.txt', PATH);
  await client.fPutObject('documents', 'second.txt', PATH);
  await delay(1000);

  await client.fPutObject('pictures', 'first.txt', PATH);
  await client.fPutObject('pictures', 'second.txt', PATH);
  await delay(1000);

  await client.fPutObject('files', 'first.txt', PATH);
  await client.fPutObject('files', 'second.txt', PATH);
  await delay(1000);

  await client.fPutObject('others', 'correct/test.txt', PATH);
  await client.fPutObject('others', 'wrong/test.csv', PATH);
  await client.fPutObject('others', 'correct/test.csv', PATH);
  await client.fPutObject('others', 'wrong/test.txt', PATH);
};

const serverless = spawn('sls', ['offline', 'start', '--config', 'serverless.s3.yml'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  cwd: __dirname
});

let lambdaCallCounter = 0;
const processedEvents = new Set();

function incrementlambdaCallCounter(eventId) {
  if (eventId && processedEvents.has(eventId)) {
    return;
  }

  if (eventId) {
    processedEvents.add(eventId);
  }

  lambdaCallCounter++;
  console.debug(`lambda call count for s3 test: ${lambdaCallCounter}/${EXPECTED_LAMBDA_CALL}`);

  if (lambdaCallCounter >= EXPECTED_LAMBDA_CALL) {
    console.log(`${lambdaCallCounter}/${EXPECTED_LAMBDA_CALL} lambda calls reached`);
    serverless.kill();
  }
}

function processS3Event(output) {
  if (!output.includes('Records') || !output.includes('eventSource":"minio:s3"')) return;

  try {
    output
      .split('\n')
      .filter(line => line.includes('Records') && line.includes('eventSource":"minio:s3"'))
      .forEach(line => {
        const jsonStart = line.indexOf('{');
        if (jsonStart < 0) return;

        const jsonEnd = line.lastIndexOf('}');
        if (jsonEnd <= jsonStart) return;

        const jsonStr = line.slice(jsonStart, jsonEnd + 1);

        const eventData = JSON.parse(jsonStr);
        if (!eventData || !eventData.Records || eventData.Records.length === 0) return;
        const eventId = `${eventData.Records[0].s3.bucket.name}-${eventData.Records[0].s3.object.key}`;
        incrementlambdaCallCounter(eventId);
      });
  } catch (err) {
    console.error('Error in processS3Event:', {err, output});
  }
}

serverless.stdout.on('data', data => {
  processS3Event(data.toString());
});

serverless.stderr.on('data', data => {
  console.log(`STDERR: ${data.toString().trim()}`);
});

pump(
  serverless.stderr,
  getSplitLinesTransform(),
  new Writable({
    objectMode: true,
    write(line, _enc, cb) {
      if (/Starting Offline S3/.test(line)) {
        uploadFiles();
      }
      cb();
    }
  })
);

onExit((code, signal) => {
  if (signal) serverless.kill(signal);
});
