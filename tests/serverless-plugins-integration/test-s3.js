const {Writable} = require('stream');
const {spawn} = require('child_process');
const Minio = require('minio');
const onExit = require('signal-exit');
const pump = require('pump');
const {delay, getSplitLinesTransform} = require('./utils');

const EXPECTED_LAMBDA_CALL = 9; // pictures files are consumed twice, by myPromiseHandler and myPythonHandler
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

  await Promise.all([
    client.fPutObject('documents', 'first.txt', PATH),
    client.fPutObject('pictures', 'first.txt', PATH),
    client.fPutObject('files', 'first.txt', PATH),
    client.fPutObject('documents', 'second.txt', PATH),
    client.fPutObject('pictures', 'second.txt', PATH),
    client.fPutObject('files', 'second.txt', PATH),
    client.fPutObject('others', 'correct/test.txt', PATH),
    client.fPutObject('others', 'wrong/test.csv', PATH),
    client.fPutObject('others', 'correct/test.csv', PATH),
    client.fPutObject('others', 'wrong/test.txt', PATH)
  ]);
};

const serverless = spawn('sls', ['offline', 'start', '--config', 'serverless.s3.yml'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  cwd: __dirname
});

pump(
  serverless.stderr,
  getSplitLinesTransform(),
  new Writable({
    objectMode: true,
    write(line, enc, cb) {
      if (/Starting Offline S3/.test(line)) {
        uploadFiles();
      }

      this.count =
        (this.count || 0) +
        (line.match(/\(λ: .*\) RequestId: .* Duration: .* ms {2}Billed Duration: .* ms/g) || [])
          .length;
      if (this.count === EXPECTED_LAMBDA_CALL) serverless.kill();
      cb();
    }
  })
);

onExit((code, signal) => {
  if (signal) serverless.kill(signal);
});
