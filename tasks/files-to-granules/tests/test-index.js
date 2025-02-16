'use strict';

const fs = require('fs');
const path = require('path');
const test = require('ava');
const { promisify } = require('util');

const {
  randomId, validateConfig, validateInput, validateOutput,
} = require('@cumulus/common/test-utils');
const { s3 } = require('@cumulus/aws-client/services');
const { recursivelyDeleteS3Bucket, s3PutObject } = require('@cumulus/aws-client/S3');
const { filesToGranules } = require('..');
const readFile = promisify(fs.readFile);

async function loadDataJSON(filename, bucket) {
  const payloadPath = path.join(__dirname, 'data', filename);
  const rawPayload = await readFile(payloadPath, 'utf8');
  const payload = rawPayload.replace(/cumulus-internal/g, bucket);
  return JSON.parse(payload);
}

test.beforeEach(async (t) => {
  t.context.bucket = randomId('bucket');
  t.context.payload = await loadDataJSON('payload.json', t.context.bucket);
  t.context.output = await loadDataJSON('output.json', t.context.bucket);

  await s3().createBucket({ Bucket: t.context.bucket }).promise();
  const updates = t.context.output.granules[0].files.map(async (f) => {
    const testdata = randomId('testdata');
    await s3PutObject({
      Bucket: t.context.bucket,
      Key: f.key,
      Body: testdata,
    });
    // only new files for the granule have the size added
    if (f.filename !== t.context.payload.config.inputGranules[0].files[0].filename) {
      f.size = testdata.length;
    }
  });
  await Promise.all(updates);
});

test.afterEach(async (t) => await recursivelyDeleteS3Bucket(t.context.bucket));

test('files-to-granules transforms files array to granules object', async (t) => {
  const event = t.context.payload;
  await validateConfig(t, event.config);
  await validateInput(t, event.input);
  const expectedOutput = t.context.output;
  const output = await filesToGranules(event);
  await validateOutput(t, output);
  t.deepEqual(output, expectedOutput);
});
