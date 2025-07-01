const {Writable} = require('stream');
const {spawn} = require('child_process');
const onExit = require('signal-exit');
const {SQS} = require('aws-sdk');
const pump = require('pump');
const {delay, getSplitLinesTransform} = require('./utils');

const EXPECTED_LAMBDA_CALLS = 3;

const client = new SQS({
  region: 'eu-west-1',
  accessKeyId: 'local',
  secretAccessKey: 'local',
  endpoint: 'http://localhost:9324',
  httpOptions: {
    connectTimeout: 4000,
    timeout: 8000
  }
});

const sendMessages = async () => {
  await client
    .sendMessage({
      QueueUrl: 'http://localhost:9324/queue/AutocreatedImplicitQueue',
      MessageBody: 'AutocreatedImplicitQueue'
    })
    .promise();

  await delay(1000);
  await client
    .sendMessage({
      QueueUrl: 'http://localhost:9324/queue/AutocreatedQueue',
      MessageBody: 'AutocreatedQueue'
    })
    .promise();
  await delay(1000);

  await client
    .sendMessage({
      QueueUrl: 'http://localhost:9324/queue/AutocreatedFifoQueue.fifo',
      MessageBody: 'AutocreatedFifoQueue',
      MessageGroupId: '1'
    })
    .promise();
};

const serverless = spawn('sls', ['offline', 'start', '--config', 'serverless.sqs.autocreate.yml'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  cwd: __dirname
});

let lambdaCallCount = 0;
const processedEvents = new Set();

function incrementCounter(eventId) {
  if (eventId && processedEvents.has(eventId)) {
    return;
  }

  if (eventId) {
    processedEvents.add(eventId);
  }

  lambdaCallCount++;
  console.debug(`SQS-autocreate: Lambda call count: ${lambdaCallCount}/${EXPECTED_LAMBDA_CALLS}`);

  if (lambdaCallCount >= EXPECTED_LAMBDA_CALLS) {
    console.log(
      `${lambdaCallCount}/${EXPECTED_LAMBDA_CALLS} lambda calls reached for sqs-autocreate test`
    );
    serverless.kill();
  }
}

function processSqsEvent(output) {
  if (!output.includes('"eventSource":"aws:sqs"')) return;

  try {
    const jsonStart = output.indexOf('{');
    if (jsonStart < 0) return;

    const jsonStr = output.slice(Math.max(0, jsonStart));
    const eventData = JSON.parse(jsonStr);

    if (!eventData || !eventData.Records || eventData.Records.length === 0) return;

    const queueName = eventData.Records[0].eventSourceARN.split(':').pop();
    const eventId = `${queueName}-${eventData.Records[0].messageId}`;

    incrementCounter(eventId);
  } catch (err) {
    console.error('Error in processSqsEvent:', err);
  }
}

serverless.stdout.on('data', data => {
  const output = data.toString();
  processSqsEvent(output);
});

pump(
  serverless.stderr,
  getSplitLinesTransform(),
  new Writable({
    objectMode: true,
    write(line, _enc, cb) {
      if (/Starting Offline SQS/.test(line)) {
        sendMessages();
      }
      cb();
    }
  })
);

async function pruneQueue(QueueName) {
  const {QueueUrl} = await client
    .getQueueUrl({QueueName})
    .promise()
    .catch(err => {
      console.log(`Ignore issue that occured pruning ${QueueName}: ${err.message}`);
      return {QueueUrl: null};
    });
  if (QueueUrl) await client.deleteQueue({QueueUrl}).promise();
}

async function cleanUp() {
  await Promise.all([
    pruneQueue('AutocreatedImplicitQueue'),
    pruneQueue('AutocreatedQueue'),
    pruneQueue('AutocreatedFifoQueue.fifo')
  ]);
}

serverless.on('close', code => {
  cleanUp()
    .then(() => {
      return process.exit(code);
    })
    .catch(err => {
      console.error(`Queue deletion failed: ${err.message}`);
      process.exit(code || 12);
    });
});

onExit((_code, signal) => {
  if (signal) serverless.kill(signal);
});
