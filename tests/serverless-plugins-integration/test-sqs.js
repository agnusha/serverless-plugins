const {Writable} = require('stream');
const {spawn} = require('child_process');
const onExit = require('signal-exit');
const {SQS} = require('aws-sdk');
const pump = require('pump');
const {delay, getSplitLinesTransform} = require('./utils');

const EXPECTED_LAMBDA_CALLS = 5;

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
  console.debug('Sending messages to SQS queues...');

  await client
    .sendMessage({
      QueueUrl: 'http://localhost:9324/queue/MyFirstQueue',
      MessageBody: 'MyFirstMessage',
      MessageAttributes: {
        myAttribute: {DataType: 'String', StringValue: 'myAttribute'}
      }
    })
    .promise();
  await delay(1000);

  await client
    .sendMessage({
      QueueUrl: 'http://localhost:9324/queue/MySecondQueue',
      MessageBody: 'MySecondMessage'
    })
    .promise();
  await delay(1000);

  await client
    .sendMessage({
      QueueUrl: 'http://localhost:9324/queue/MyThirdQueue',
      MessageBody: 'MyThirdMessage'
    })
    .promise();
  await delay(1000);

  await client
    .sendMessage({
      QueueUrl: 'http://localhost:9324/queue/MyFourthQueue',
      MessageBody: 'MyFourthMessage'
    })
    .promise();
  await delay(1000);

  const batchEntries = Array.from({length: 10}).map((_, index) => ({
    Id: `msg-${index}`,
    MessageBody: 'MyLargestBatchSizeQueue'
  }));
  await client
    .sendMessageBatch({
      QueueUrl: 'http://localhost:9324/queue/MyLargestBatchSizeQueue',
      Entries: batchEntries
    })
    .promise();
};

const serverless = spawn('sls', ['offline', 'start', '--config', 'serverless.sqs.yml'], {
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
  console.log(`Lambda call count: ${lambdaCallCount}/${EXPECTED_LAMBDA_CALLS}`);
  if (lambdaCallCount >= EXPECTED_LAMBDA_CALLS) {
    serverless.kill();
  }
}

function processSqsEvent(output) {
  if (!output.includes('"eventSource":"aws:sqs"')) return;

  try {
    const jsonStart = output.indexOf('{');
    const jsonEnd = output.lastIndexOf('}');
    if (jsonStart < 0 || jsonEnd < 0 || jsonEnd <= jsonStart) {
      return;
    }

    const jsonStr = output.slice(jsonStart, jsonEnd + 1);
    const eventData = JSON.parse(jsonStr);
    if (!eventData || !eventData.Records || eventData.Records.length === 0) return;
    eventData.Records.forEach(record => {
      if (!record.eventSourceARN) return;

      const queueName = record.eventSourceARN.split(':').pop();
      const eventId = `${queueName}-${record.messageId}`;

      incrementCounter(eventId);
    });
  } catch (err) {
    console.error('Error in processSqsEvent:', {err, output});
  }
}

serverless.stdout.on('data', data => processSqsEvent(data.toString()));
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

serverless.on('close', code => process.exit(code));

onExit((code, signal) => {
  if (signal) serverless.kill(signal);
});
