const {get, isUndefined, omitBy, pick} = require('lodash/fp');

const S3 = require('./s3');

const OFFLINE_OPTION = 'serverless-offline';
const CUSTOM_OPTION = 'serverless-offline-s3';

const SERVER_SHUTDOWN_TIMEOUT = 5000;

const defaultOptions = {
  batchSize: 100,
  startingPosition: 'TRIM_HORIZON'
};

const omitUndefined = omitBy(isUndefined);

class ServerlessOfflineS3 {
  constructor(serverless, cliOptions, {log}) {
    this.cliOptions = null;
    this.options = null;
    this.s3 = null;
    this.lambda = null;
    this.serverless = null;
    this.log = null;

    this.cliOptions = cliOptions;
    this.serverless = serverless;
    this.log = log;

    this.hooks = {
      'offline:start:init': this.start.bind(this),
      'offline:start:ready': this.ready.bind(this),
      'offline:start': this._startWithReady.bind(this),
      'offline:start:end': this.end.bind(this)
    };
  }

  async start() {
    process.env.IS_OFFLINE = true;

    this._mergeOptions();

    const {s3Events, lambdas} = this._getEvents();

    await this._createLambda(lambdas);

    const eventModules = [];

    if (s3Events.length > 0) {
      eventModules.push(this._createS3(s3Events));
    }

    await Promise.all(eventModules);

    this.log.notice(
      `Starting Offline S3 at stage ${this.options.stage} (${this.options.endPoint}/${this.options.region})`
    );
  }

  ready() {
    if (process.env.NODE_ENV !== 'test') {
      this._listenForTermination();
    }
  }

  _listenForTermination() {
    const signals = ['SIGINT', 'SIGTERM'];

    signals.map(signal =>
      process.on(signal, async () => {
        this.log.notice(`Got ${signal} signal. Offline Halting...`);

        await this.end();
      })
    );
  }

  async _startWithReady() {
    await this.start();
    this.ready();
  }

  async end(skipExit) {
    if (process.env.NODE_ENV === 'test' && skipExit === undefined) {
      return;
    }

    this.log.notice('Halting offline server');

    const eventModules = [];

    if (this.lambda) {
      eventModules.push(this.lambda.cleanup());
    }

    if (this.s3) {
      eventModules.push(this.s3.stop(SERVER_SHUTDOWN_TIMEOUT));
    }

    await Promise.all(eventModules);

    if (!skipExit) {
      process.exit(0);
    }
  }

  async _createLambda(lambdas) {
    const {default: Lambda} = await import('serverless-offline/lambda');
    this.lambda = new Lambda(this.serverless, this.options);

    this.lambda.create(lambdas);
  }

  async _createS3(events, skipStart) {
    const resources = this._getResources();

    this.s3 = new S3(this.lambda, resources, this.options, this.log);

    await this.s3.create(events);

    if (!skipStart) {
      await this.s3.start();
    }
  }

  _mergeOptions() {
    const {
      service: {custom = {}, provider}
    } = this.serverless;

    const offlineOptions = custom[OFFLINE_OPTION];
    const customOptions = custom[CUSTOM_OPTION];

    this.options = Object.assign(
      {},
      omitUndefined(defaultOptions),
      omitUndefined(provider),
      omitUndefined(pick(['location', 'localEnvironment'], offlineOptions)), // serverless-webpack support
      omitUndefined(customOptions),
      omitUndefined(this.cliOptions)
    );

    this.log.debug('s3 options:', this.options);
  }

  _getEvents() {
    const {service} = this.serverless;

    const lambdas = [];
    const s3Events = [];

    const functionKeys = service.getAllFunctions();

    functionKeys.forEach(functionKey => {
      const functionDefinition = service.getFunction(functionKey);

      lambdas.push({functionKey, functionDefinition});

      const events = service.getAllEventsInFunction(functionKey) || [];

      events.forEach(event => {
        const {s3} = event;

        if (s3 && functionDefinition.handler) {
          s3Events.push({
            functionKey,
            handler: functionDefinition.handler,
            s3
          });
        }
      });
    });

    return {
      s3Events,
      lambdas
    };
  }

  _getResources() {
    const Resources = get(['service', 'resources', 'Resources'], this.serverless);
    return Resources;
  }
}

module.exports = ServerlessOfflineS3;
