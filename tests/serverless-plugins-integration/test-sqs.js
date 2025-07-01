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
    connectTimeout: 10000,
    timeout: 15000
  },
  maxRetries: 5
});

async function ensureQueueExists(queueName) {
  try {
    console.log(`Checking if queue ${queueName} exists...`);
    const queueUrl = `http://localhost:9324/queue/${queueName}`;
    await client
      .getQueueAttributes({
        QueueUrl: queueUrl,
        AttributeNames: ['QueueArn']
      })
      .promise();

    return true;
  } catch (err) {
    console.error(`Queue ${queueName} does not exist or is not accessible: ${err.message}`);
    return false;
  }
}

const sendMessages = async () => {
  console.debug('Sending messages to SQS queues...');

  console.log('Checking SQS availability...');
  await delay(1000);

  const queues = [
    'MyFirstQueue',
    'MySecondQueue',
    'MyThirdQueue',
    'MyFourthQueue',
    'MyLargestBatchSizeQueue'
  ];

  await Promise.all(queues.map(queue => ensureQueueExists(queue)));

  console.log('Sending message to MyFirstQueue');
  await client
    .sendMessage({
      QueueUrl: 'http://localhost:9324/queue/MyFirstQueue',
      MessageBody: 'MyFirstMessage',
      MessageAttributes: {
        myAttribute: {DataType: 'String', StringValue: 'myAttribute'}
      }
    })
    .promise()
    .catch(err => console.error('Error sending to MyFirstQueue:', err.message));
  await delay(2000);

  console.log('Sending message to MySecondQueue');
  await client
    .sendMessage({
      QueueUrl: 'http://localhost:9324/queue/MySecondQueue',
      MessageBody: 'MySecondMessage'
    })
    .promise()
    .catch(err => console.error('Error sending to MySecondQueue:', err.message));
  await delay(2000);

  console.log('Sending message to MyThirdQueue');
  await client
    .sendMessage({
      QueueUrl: 'http://localhost:9324/queue/MyThirdQueue',
      MessageBody: 'MyThirdMessage'
    })
    .promise()
    .catch(err => console.error('Error sending to MyThirdQueue:', err.message));
  await delay(2000);

  console.log('Sending message to MyFourthQueue');
  await client
    .sendMessage({
      QueueUrl: 'http://localhost:9324/queue/MyFourthQueue',
      MessageBody: 'MyFourthMessage'
    })
    .promise()
    .catch(err => console.error('Error sending to MyFourthQueue:', err.message));
  await delay(2000);

  console.log('Sending batch messages to MyLargestBatchSizeQueue');
  const batchEntries = Array.from({length: 10}).map((_, index) => ({
    Id: `msg-${index}`,
    MessageBody: 'MyLargestBatchSizeQueue'
  }));

  await client
    .sendMessageBatch({
      QueueUrl: 'http://localhost:9324/queue/MyLargestBatchSizeQueue',
      Entries: batchEntries
    })
    .promise()
    .catch(err => console.error('Error sending batch to MyLargestBatchSizeQueue:', err.message));

  console.log('All messages sent successfully');
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
    console.log('All expected lambda calls received, shutting down');
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

serverless.stdout.on('data', data => {
  const output = data.toString();
  console.log(`STDOUT: ${output.trim()}`);
  processSqsEvent(output);
});

serverless.stderr.on('data', data => {
  console.log(`STDERR: ${data.toString().trim()}`);
});

serverless.on('close', code => {
  process.exit(code || 0);
});

onExit((code, signal) => {
  if (signal) serverless.kill(signal);
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
