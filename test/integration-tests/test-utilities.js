'use strict';

const request = require('request-promise-native');
const aws = require('aws-sdk');
const dns = require('dns');
const shell = require('shelljs');

const AWS_PROFILE = process.env.AWS_PROFILE;
const apiGateway = new aws.APIGateway({
  region: 'us-west-2',
  credentials: new aws.SharedIniFileCredentials(
    { profile: AWS_PROFILE },
  ),
});

class CreationError extends Error {}


/**
 * Stops event thread execution for given number of seconds.
 * @param seconds
 * @returns {Promise<any>} Resolves after given number of seconds.
 */
function sleep(seconds) {
  return new Promise(resolve => setTimeout(resolve, 1000 * seconds));
}

/**
 * Links current serverless-domain-manager to global node_modules in order to run tests.
 * @returns {Promise<boolean>} Resolves true if successfully linked, else false.
 */
async function linkPackages() {
  return new Promise((resolve) => {
    shell.exec('npm link serverless-domain-manager', { silent: true }, (err, stdout, stderr) => {
      if (err || stderr) {
        return resolve(false);
      }
      return resolve(true);
    });
  });
}

/**
 * Curls the given URL to see if it exists
 * @param url
 * @returns {Promise<Number|null>} Resolves to status code if exists, else null.
 */
async function curlUrl(url) {
  let response = null;
  response = await request.get({
    url,
    resolveWithFullResponse: true,
  })
  .catch((err) => { // eslint-disable-line no-unused-vars
    response = null;
  });
  if (response === undefined || response === null) {
    return null;
  }
  return response.statusCode;
}

/**
 * Gets endpoint type of given URL from AWS
 * @param url
 * @returns {Promise<String|null>} Resolves to String if endpoint exists, else null.
 */
async function getEndpointType(url) {
  const params = {
    domainName: url,
  };
  try {
    const result = await apiGateway.getDomainName(params).promise();
    return result.endpointConfiguration.types[0];
  } catch (err) {
    return null;
  }
}

/**
 * Gets stage of given URL from AWS
 * @param url
 * @returns {Promise<String|null>} Resolves to String if stage exists, else null.
 */
async function getStage(url) {
  const params = {
    domainName: url,
  };
  try {
    const result = await apiGateway.getBasePathMappings(params).promise();
    return result.items[0].stage;
  } catch (err) {
    return null;
  }
}

/**
 * Gets basePath of given URL from AWS
 * @param url
 * @returns {Promise<String|null>} Resolves to String if basePath exists, else null.
 */
async function getBasePath(url) {
  const params = {
    domainName: url,
  };
  try {
    const result = await apiGateway.getBasePathMappings(params).promise();
    return result.items[0].basePath;
  } catch (err) {
    return null;
  }
}

/**
 * Creates the lambda function and associated domain name in given folder
 * @param folderName
 * @param randString
 * @returns {Promise<boolean>} Resolves true if lambda deployed, else false.
 */
function deployLambdas(folderName, randString) {
  return new Promise((resolve) => {
    shell.exec(`cd 'test/integration-tests/${folderName}' && sls create_domain --RANDOM_STRING ${randString} && sls deploy --RANDOM_STRING ${randString} `, { silent: true }, (err, stdout, stderr) => {
      if (err || stderr) {
        return resolve(false);
      }
      return resolve(true);
    });
  });
}

/**
 * Looks up DNS records for the given url
 * @param url
 * @returns {Promise<boolean>} Resolves true if DNS records exist, else false.
 */
function dnsLookup(url) {
  return new Promise((resolve) => {
    dns.resolveAny(url, (err) => {
      if (err) {
        return resolve(false);
      }
      return resolve(true);
    });
  });
}

/**
 * Periodically calls dnsLookup until records found or 40 minutes elapse.
 * @param url
 * @param enabled
 * @returns {Promise<boolean>} Resolves true if records found, else false.
 */
async function verifyDnsPropogation(url, enabled) {
  console.debug('\tWaiting for DNS to Propogate...'); // eslint-disable-line no-console
  if (!enabled) {
    return true;
  }
  let numRetries = 0;
  let dnsPropogated = false;
  while (numRetries < 40 && !dnsPropogated && enabled) {
    dnsPropogated = await dnsLookup(url); // eslint-disable-line no-await-in-loop
    if (dnsPropogated) {
      break;
    }
    numRetries += 1;
    await sleep(60); // eslint-disable-line no-await-in-loop
  }
  return dnsPropogated;
}

/**
 * Removes the lambda function and associated domain name from given folder
 * @param folderName
 * @returns {Promise<boolean>} Resolves to true if lambda removed, else false.
 */
function removeLambdas(folderName) {
  return new Promise((resolve) => {
    shell.exec(`cd 'test/integration-tests/${folderName}' && sls delete_domain && sls remove`, { silent: true }, (err, stdout, stderr) => {
      if (err || stderr) {
        return resolve(false);
      }
      return resolve(true);
    });
  });
}

/**
 * Wraps creation of testing resources.
 * @param folderName
 * @param url
 * @param randString
 * @param enabled
 * @returns {Promise<boolean>} Resolves true if resources created, else false.
 */
async function createResources(folderName, url, randString, enabled) {
  console.debug(`\tCreating Resources for ${url}`); // eslint-disable-line no-console
  const created = await deployLambdas(folderName, randString);
  let dnsVerified = false;
  if (created) {
    dnsVerified = await verifyDnsPropogation(url, enabled);
  }
  if (created && dnsVerified) {
    console.debug('\tResources Created'); // eslint-disable-line no-console
  } else {
    console.debug('\tResources Failed to Create'); // eslint-disable-line no-console
  }
  return created && dnsVerified;
}

/**
 * Wraps deletion of testing resources.
 * @param folderName
 * @param url
 * @returns {Promise<boolean>} Resolves true if resources destroyed, else false.
 */
async function destroyResources(folderName, url) {
  console.debug(`\tCleaning Up Resources for ${url}`); // eslint-disable-line no-console
  const removed = await removeLambdas(folderName);
  if (removed) {
    console.debug('\tResources Cleaned Up'); // eslint-disable-line no-console
  } else {
    console.debug('\tFailed to Clean Up Resources'); // eslint-disable-line no-console
  }
  return removed;
}

module.exports = {
  curlUrl,
  createResources,
  destroyResources,
  verifyDnsPropogation,
  dnsLookup,
  deployLambdas,
  getEndpointType,
  getBasePath,
  getStage,
  linkPackages,
  sleep,
  CreationError,
};
