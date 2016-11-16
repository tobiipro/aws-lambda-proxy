import _ from 'lodash';
import bodyParser from 'body-parser';
import compression from 'compression';
import express from 'express';
import fs from 'fs';
import ini from 'ini';
import url from 'url';
import aws from 'aws-sdk';

// compatibility with aws-cli
let awsProfile = process.env.AWS_PROFILE || process.env.AWS_DEFAULT_PROFILE;
if (awsProfile) {
  try {
    let configIni = ini.parse(fs.readFileSync(
      `${process.env.HOME}/.aws/config`,
      'utf-8'
    ));
    let awsProfileConfig = configIni[`profile ${awsProfile}`];
    if (awsProfileConfig && awsProfileConfig.role_arn) {
      let roleArn = awsProfileConfig.role_arn.replace(/:/g, '_').replace(/[^A-Za-z0-9\-_]/g, '-');
      let awsCliCacheFilename = `${awsProfile}--${roleArn}`;
      let awsCliCache =
          JSON.parse(fs.readFileSync(
            `${process.env.HOME}/.aws/cli/cache/${awsCliCacheFilename}.json`,
            'utf-8'
          ));
      let sts = new aws.STS();
      aws.config.credentials = sts.credentialsFrom(awsCliCache);
    }
  } catch (_err) {
  }
}

let awsLambda = new aws.Lambda({apiVersion: '2015-03-31'});

export let base64 = function(string) {
  // maintain Node.js v4 compatibility
  // return Buffer.from(string).toString('base64').slice(0, -1);
  return new Buffer(string).toString('base64').slice(0, -1);
};

export let create = function(options) {
  let app = express();
  let hashedEnv = base64(process.env.ENV_NAME);

  app.disable('x-powered-by');
  app.disable('etag');
  app.enable('trust proxy');
  app.use(compression());
  app.use(bodyParser.raw({type: '*/*'}));

  app.env = options.env;
  app.log = options.log;

  app.use(function(req, _res, next) {
    // bodyParser return {} if no body
    if (_.isEmpty(req.body)) {
      delete req.body;
    }

    if (req.path === `/health.${hashedEnv}`) {
      return next();
    }
    let slimReq = _.omit(req, [
      '_parsedUrl',
      '_readableState',
      'client',
      'connection',
      'host',
      'res',
      'socket'
    ]);
    if (slimReq.body instanceof Buffer) {
      slimReq.body = slimReq.body.toString();
    }
    options.log.debug({req: slimReq});
    next();
  });

  app.get(`/health.${hashedEnv}`, function(_req, res, _next) {
    res.sendStatus(200);
  });

  app.loadLambdas = function({lambdas, stageVariables}) {
    return exports.loadLambdas({
      app,
      lambdas,
      stageVariables
    });
  };

  app.use(function(err, _req, res, _next) {
    if (err == null) {
      return res.sendStatus(404);
    }
    options.log.error({err});
    return res.sendStatus(500);
  });

  return app;
};

export let loadLambdas = function({app, lambdas, stageVariables}) {
  let locations = [];
  let arnPrefix = [
    'arn',
    'aws',
    'lambda',
    process.env.AWS_REGION || 'zz-central-1',
    process.env.AWS_ACCOUNT_ID,
    'function'
  ].join(':');

  _.each(lambdas, function({name, pkg, handle}) {
    _.each(_.get(pkg, 'config.aws-lambda.locations', []), function(location) {
      // location = location.replace(/{([^}]+)\+}/g, ':$1');
      location = location.replace(/{([^}]+)\+}/g, '*');
      location = `${location}$`;
      let functionName = `${process.env.ENV_NAME}-${name}`;
      let ctx = {
        functionName,
        functionVersion: '$LOCAL',
        invokedFunctionArn: `${arnPrefix}:${functionName}:$LOCAL`
      };
      locations.push({
        location,
        stageVariables,
        ctx,
        handle
      });
    });
  });

  _.each(locations, function({location, stageVariables, ctx, handle}) {
    app.all(location, exports.middleware({
      location,
      stageVariables,
      ctx,
      handle
    }));
  });
};

export let middleware = function({stageVariables, ctx, handle}) {
  return function(req, res, _next) {
    let {
      pathname,
      query
    } = url.parse(req.originalUrl, true);

    handle({
      httpMethod: req.method,
      path: pathname,
      querystring: query,
      headers: req.headers,
      body: req.body ? req.body.toString() : undefined,
      stageVariables,
      requestContext: {
        accountId: process.env.AWS_ACCOUNT_ID,
        stage: 'local',
        httpMethod: req.method
      }
    }, ctx, function(err, lambdaRes) {
      if (err) {
        req.app.log.error({err});
        return res.status(500);
      }
      res.status(lambdaRes.statusCode);
      res.set(lambdaRes.headers);
      res.send(lambdaRes.body);
    });
  };
};

export let makeLambdaProxyHandle = function(app, name) {
  return function(e, ctx = {}, cb = _.noop) {
    let basePath = url.parse(e.stageVariables.API_BASE_URL).pathname;
    if (basePath !== '/') {
      e.path = `${basePath}${e.path}`;
    }

    app.log.trace({
      tag_lambda: 'request',
      req: e
    });

    e = _.merge(
      {},
      _.omit(e, ['requestContext']),
      {ctx}
    );

    awsLambda.invoke({
      FunctionName: `${app.env.project.name}-${name}`,
      ClientContext: undefined,
      InvocationType: 'RequestResponse',
      LogType: 'None',
      Payload: JSON.stringify(e),
      Qualifier: '$LATEST'
    }, function(err, data) {
      if (err) {
        app.log.error({err});
        return cb(err);
      }

      let body = data.Payload ? JSON.parse(data.Payload) : undefined;
      delete data.Payload;

      app.log.trace({
        tag_lambda: 'response',
        res: body,
        lambda_data: data
      });

      cb(null, body);
    });
  };
};
