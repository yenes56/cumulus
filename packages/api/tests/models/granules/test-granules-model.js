'use strict';

const test = require('ava');
const pick = require('lodash/pick');
const sortBy = require('lodash/sortBy');
const sinon = require('sinon');

const awsServices = require('@cumulus/aws-client/services');
const Lambda = require('@cumulus/aws-client/Lambda');
const s3Utils = require('@cumulus/aws-client/S3');
const StepFunctions = require('@cumulus/aws-client/StepFunctions');
const launchpad = require('@cumulus/launchpad-auth');
const { randomString, randomId } = require('@cumulus/common/test-utils');
const { DefaultProvider } = require('@cumulus/common/key-pair-provider');
const { CMR } = require('@cumulus/cmr-client');
const { constructCollectionId } = require('@cumulus/message/Collections');

const Rule = require('../../../models/rules');
const Granule = require('../../../models/granules');
const { fakeFileFactory, fakeGranuleFactoryV2 } = require('../../../lib/testUtils');

let fakeExecution;
let testCumulusMessage;
let sandbox;

test.before(async () => {
  process.env.GranulesTable = randomString();
  await new Granule().createTable();

  testCumulusMessage = {
    cumulus_meta: {
      execution_name: randomString(),
      state_machine: 'arn:aws:states:us-east-1:123456789012:stateMachine:HelloStateMachine',
      workflow_start_time: Date.now(),
    },
    meta: {
      collection: {
        name: randomString(),
        version: randomString(),
      },
      provider: {
        host: randomString(),
        protocol: 's3',
      },
      status: 'completed',
    },
    payload: {
      granules: [
        {
          granuleId: randomString(),
          sync_granule_duration: 123,
          post_to_cmr_duration: 456,
          files: [],
        },
      ],
    },
  };

  sandbox = sinon.createSandbox();

  fakeExecution = {
    input: JSON.stringify(testCumulusMessage),
    startDate: new Date(Date.UTC(2019, 6, 28)),
    stopDate: new Date(Date.UTC(2019, 6, 28, 1)),
  };
  sandbox.stub(StepFunctions, 'describeExecution').resolves(fakeExecution);

  // Store the CMR password
  process.env.cmr_password_secret_name = randomString();
  await awsServices.secretsManager().createSecret({
    Name: process.env.cmr_password_secret_name,
    SecretString: randomString(),
  }).promise();

  // Store the launchpad passphrase
  process.env.launchpad_passphrase_secret_name = randomString();
  await awsServices.secretsManager().createSecret({
    Name: process.env.launchpad_passphrase_secret_name,
    SecretString: randomString(),
  }).promise();
});

test.beforeEach((t) => {
  t.context.granuleModel = new Granule();
});

test.after.always(async () => {
  await awsServices.secretsManager().deleteSecret({
    SecretId: process.env.cmr_password_secret_name,
    ForceDeleteWithoutRecovery: true,
  }).promise();
  await awsServices.secretsManager().deleteSecret({
    SecretId: process.env.launchpad_passphrase_secret_name,
    ForceDeleteWithoutRecovery: true,
  }).promise();
  await new Granule().deleteTable();
  sandbox.restore();
});

test('files existing at location returns empty array if no files exist', async (t) => {
  const filenames = [
    'granule-file-1.hdf',
    'granule-file-2.hdf',
  ];

  const sourceBucket = 'test-bucket';
  const destBucket = 'dest-bucket';

  const sourceFiles = filenames.map(
    (name) =>
      fakeFileFactory({
        name,
        bucket: sourceBucket,
        key: `origin/${name}`,
      })
  );

  const destinationFilepath = 'destination';

  const destinations = [
    {
      regex: '.*.hdf$',
      bucket: destBucket,
      key: destinationFilepath,
    },
  ];

  const granule = {
    files: sourceFiles,
  };

  const granulesModel = new Granule();

  const filesExisting = await granulesModel.getFilesExistingAtLocation(granule, destinations);

  t.deepEqual(filesExisting, []);
});

test('files existing at location returns both files if both exist', async (t) => {
  const filenames = [
    'granule-file-1.hdf',
    'granule-file-2.hdf',
  ];

  const sourceBucket = 'test-bucket';
  const destBucket = randomString();

  await awsServices.s3().createBucket({ Bucket: destBucket }).promise();

  const sourceFiles = filenames.map(
    (fileName) => fakeFileFactory({ fileName, bucket: sourceBucket })
  );

  const destinations = [
    {
      regex: '.*.hdf$',
      bucket: destBucket,
    },
  ];

  const dataSetupPromises = filenames.map(async (filename) => {
    const params = {
      Bucket: destBucket,
      Key: filename,
      Body: 'test',
    };
    return await awsServices.s3().putObject(params).promise();
  });

  await Promise.all(dataSetupPromises);

  const granule = {
    files: sourceFiles,
  };

  const granulesModel = new Granule();

  const filesExisting = await granulesModel.getFilesExistingAtLocation(granule, destinations);

  t.deepEqual(filesExisting, sourceFiles);

  await s3Utils.recursivelyDeleteS3Bucket(destBucket);
});

test('files existing at location returns only file that exists', async (t) => {
  const filenames = [
    'granule-file-1.hdf',
    'granule-file-2.hdf',
  ];

  const sourceBucket = 'test-bucket';
  const destBucket = randomString();

  await awsServices.s3().createBucket({ Bucket: destBucket }).promise();

  const sourceFiles = filenames.map(
    (fileName) => fakeFileFactory({ fileName, bucket: sourceBucket })
  );

  const destinations = [
    {
      regex: '.*.hdf$',
      bucket: destBucket,
      filepath: '',
    },
  ];

  const params = {
    Bucket: destBucket,
    Key: filenames[1],
    Body: 'test',
  };
  await awsServices.s3().putObject(params).promise();

  const granule = {
    files: sourceFiles,
  };

  const granulesModel = new Granule();

  const filesExisting = await granulesModel.getFilesExistingAtLocation(granule, destinations);

  t.deepEqual(filesExisting, [sourceFiles[1]]);

  await s3Utils.recursivelyDeleteS3Bucket(destBucket);
});

test('files existing at location returns only file that exists with multiple destinations', async (t) => {
  const filenames = [
    'granule-file-1.txt',
    'granule-file-2.hdf',
  ];

  const sourceBucket = 'test-bucket';
  const destBucket1 = randomString();
  const destBucket2 = randomString();

  await Promise.all([
    awsServices.s3().createBucket({ Bucket: destBucket1 }).promise(),
    awsServices.s3().createBucket({ Bucket: destBucket2 }).promise(),
  ]);

  const sourceFiles = filenames.map(
    (fileName) => fakeFileFactory({ fileName, bucket: sourceBucket })
  );

  const destinations = [
    {
      regex: '.*.txt$',
      bucket: destBucket1,
      filepath: '',
    },
    {
      regex: '.*.hdf$',
      bucket: destBucket2,
      filepath: '',
    },
  ];

  let params = {
    Bucket: destBucket1,
    Key: filenames[0],
    Body: 'test',
  };
  await awsServices.s3().putObject(params).promise();

  params = {
    Bucket: destBucket2,
    Key: filenames[1],
    Body: 'test',
  };
  await awsServices.s3().putObject(params).promise();

  const granule = {
    files: sourceFiles,
  };

  const granulesModel = new Granule();

  const filesExisting = await granulesModel.getFilesExistingAtLocation(granule, destinations);

  t.deepEqual(filesExisting, sourceFiles);

  await Promise.all([
    s3Utils.recursivelyDeleteS3Bucket(destBucket1),
    s3Utils.recursivelyDeleteS3Bucket(destBucket2),
  ]);
});

test('get() will translate an old-style granule file into the new schema', async (t) => {
  const oldFile = {
    bucket: 'my-bucket',
    filename: 's3://my-bucket/path/to/file.txt',
    filepath: 'path/to/file.txt',
    name: 'file123.txt',
    path: 'source/path',
    checksumType: 'my-checksumType',
    checksumValue: 'my-checksumValue',
    url_path: 'some-url-path',
    fileSize: 1234,
  };

  const granule = fakeGranuleFactoryV2({ files: [oldFile] });

  await awsServices.dynamodbDocClient().put({
    TableName: process.env.GranulesTable,
    Item: granule,
  }).promise();

  const granuleModel = new Granule();
  const fetchedGranule = await granuleModel.get({ granuleId: granule.granuleId });

  t.deepEqual(
    fetchedGranule.files[0],
    {
      bucket: 'my-bucket',
      key: 'path/to/file.txt',
      fileName: 'file123.txt',
      checksumType: 'my-checksumType',
      checksum: 'my-checksumValue',
      size: 1234,
    }
  );
});

test('get() will correctly return a granule file stored using the new schema', async (t) => {
  const newFile = {
    bucket: 'my-bucket',
    key: 'path/to/file.txt',
    fileName: 'file123.txt',
    checksumType: 'my-checksumType',
    checksum: 'my-checksumValue',
    size: 1234,
  };

  const granule = fakeGranuleFactoryV2({ files: [newFile] });

  await awsServices.dynamodbDocClient().put({
    TableName: process.env.GranulesTable,
    Item: granule,
  }).promise();

  const granuleModel = new Granule();
  const fetchedGranule = await granuleModel.get({ granuleId: granule.granuleId });

  t.deepEqual(
    fetchedGranule.files[0],
    {
      bucket: 'my-bucket',
      key: 'path/to/file.txt',
      fileName: 'file123.txt',
      checksumType: 'my-checksumType',
      checksum: 'my-checksumValue',
      size: 1234,
    }
  );
});

test('getRecord() returns a granule record from the database', async (t) => {
  const granule = fakeGranuleFactoryV2();

  await awsServices.dynamodbDocClient().put({
    TableName: process.env.GranulesTable,
    Item: granule,
  }).promise();

  const granuleModel = new Granule();

  const fetchedGranule = await granuleModel.getRecord({
    granuleId: granule.granuleId,
  });

  t.is(fetchedGranule.granuleId, granule.granuleId);
});

test('batchGet() will translate old-style granule files into the new schema', async (t) => {
  const oldFile = {
    bucket: 'my-bucket',
    filename: 's3://my-bucket/path/to/file.txt',
    filepath: 'path/to/file.txt',
    name: 'file123.txt',
    path: 'source/path',
    checksumType: 'my-checksumType',
    checksumValue: 'my-checksumValue',
    url_path: 'some-url-path',
    fileSize: 1234,
  };

  const granule = fakeGranuleFactoryV2({ files: [oldFile] });

  await awsServices.dynamodbDocClient().put({
    TableName: process.env.GranulesTable,
    Item: granule,
  }).promise();

  const granuleModel = new Granule();
  const batchGetResponse = await granuleModel.batchGet([
    { granuleId: granule.granuleId },
  ]);

  const fetchedGranule = batchGetResponse.Responses[process.env.GranulesTable][0];

  t.deepEqual(
    fetchedGranule.files[0],
    {
      bucket: 'my-bucket',
      key: 'path/to/file.txt',
      fileName: 'file123.txt',
      checksumType: 'my-checksumType',
      checksum: 'my-checksumValue',
      size: 1234,
    }
  );
});

test('scan() will translate old-style granule files into the new schema', async (t) => {
  const oldFile = {
    bucket: 'my-bucket',
    filename: 's3://my-bucket/path/to/file.txt',
    filepath: 'path/to/file.txt',
    name: 'file123.txt',
    path: 'source/path',
    checksumType: 'my-checksumType',
    checksumValue: 'my-checksumValue',
    url_path: 'some-url-path',
    fileSize: 1234,
  };

  const granule = fakeGranuleFactoryV2({ files: [oldFile] });

  await awsServices.dynamodbDocClient().put({
    TableName: process.env.GranulesTable,
    Item: granule,
  }).promise();

  const granuleModel = new Granule();
  const scanResponse = await granuleModel.scan({
    names: { '#granuleId': 'granuleId' },
    filter: '#granuleId = :granuleId',
    values: { ':granuleId': granule.granuleId },
  });

  t.deepEqual(
    scanResponse.Items[0].files[0],
    {
      bucket: 'my-bucket',
      key: 'path/to/file.txt',
      fileName: 'file123.txt',
      checksumType: 'my-checksumType',
      checksum: 'my-checksumValue',
      size: 1234,
    }
  );
});

test('getGranulesForCollection() only returns granules belonging to the specified collection', async (t) => {
  const { granuleModel } = t.context;

  const expectedGranule = fakeGranuleFactoryV2({ collectionId: 'good-collection' });

  await granuleModel.create([
    expectedGranule,
    fakeGranuleFactoryV2({ collectionId: 'bad-collection' }),
  ]);

  const granules = await granuleModel.getGranulesForCollection('good-collection');

  const { granuleId } = await granules.shift();
  t.is(granuleId, expectedGranule.granuleId);
  t.is(await granules.shift(), null);
});

test('getGranulesForCollection() sorts its results by granuleId', async (t) => {
  const { granuleModel } = t.context;

  const collectionId = randomString();
  const granules = [
    fakeGranuleFactoryV2({ collectionId }),
    fakeGranuleFactoryV2({ collectionId }),
  ];

  await granuleModel.create(granules);

  const granulesQueue = await granuleModel.getGranulesForCollection(collectionId);

  const fetchedGranules = [
    await granulesQueue.shift(),
    await granulesQueue.shift(),
  ];

  t.is(await granulesQueue.shift(), null);

  t.deepEqual(
    fetchedGranules.map((g) => g.granuleId).sort(),
    granules.map((g) => g.granuleId).sort()
  );
});

test('getGranulesForCollection() filters by status', async (t) => {
  const { granuleModel } = t.context;

  const collectionId = randomString();
  const expectedGranule = fakeGranuleFactoryV2({ collectionId, status: 'completed' });

  await granuleModel.create([
    expectedGranule,
    fakeGranuleFactoryV2({ collectionId, status: 'failed' }),
  ]);

  const granules = await granuleModel.getGranulesForCollection(collectionId, 'completed');

  const { granuleId } = await granules.shift();
  t.is(granuleId, expectedGranule.granuleId);
  t.is(await granules.shift(), null);
});

test('searchGranulesForCollection() returns matching granules ordered by granuleId', async (t) => {
  const { granuleModel } = t.context;

  const collectionId = randomString();
  const provider = randomString();
  const status = 'running';
  const granules = [
    fakeGranuleFactoryV2({ collectionId, provider, status }),
    fakeGranuleFactoryV2({ collectionId, provider, status }),
    fakeGranuleFactoryV2({ collectionId, provider, status: 'completed' }),
    fakeGranuleFactoryV2({ collectionId, provider: randomString(), status: 'completed' }),
  ];
  await granuleModel.create(granules);

  const fields = ['granuleId', 'collectionId', 'provider', 'createdAt', 'status'];

  let searchParams = {
    provider,
    status,
    updatedAt__from: Date.now() - 1000 * 30,
    updatedAt__to: Date.now(),
  };
  let granulesQueue = await granuleModel
    .searchGranulesForCollection(collectionId, searchParams, fields);

  let fetchedGranules = await granulesQueue.empty();
  t.is(fetchedGranules.length, 2);
  const expectedGranules = granules.slice(0, 2).map((granule) => pick(granule, fields));
  t.deepEqual(fetchedGranules, sortBy(expectedGranules, ['granuleId']));

  // array parameters
  searchParams = {
    ...searchParams,
    provider: [provider, randomId('provider')],
    granuleId: granules[0].granuleId,
  };
  granulesQueue = await granuleModel
    .searchGranulesForCollection(collectionId, searchParams, fields);

  fetchedGranules = await granulesQueue.empty();
  t.is(fetchedGranules.length, 1);
  t.deepEqual(fetchedGranules[0], pick(granules[0], fields));

  // test when no granule falls within the search parameter range
  searchParams = {
    provider,
    status,
    updatedAt__from: Date.now(),
  };
  granulesQueue = await granuleModel
    .searchGranulesForCollection(collectionId, searchParams, fields);
  fetchedGranules = await granulesQueue.empty();
  t.is(fetchedGranules.length, 0);
});

test('granuleAttributeScan() returns granules filtered by search params', async (t) => {
  const { granuleModel } = t.context;

  const collectionId = randomString();
  const provider = randomString();
  const status = 'running';
  const granules = [
    fakeGranuleFactoryV2({ collectionId, status }),
    fakeGranuleFactoryV2({ collectionId, status, provider }),
    fakeGranuleFactoryV2({ granuleId: 'test123', collectionId, status }),
    fakeGranuleFactoryV2({ collectionId, status: 'completed' }),
    fakeGranuleFactoryV2({ collectionId: randomString(), status: 'completed' }),
  ];
  await granuleModel.create(granules);

  const searchParams = {
    collectionId,
    status,
    updatedAt__from: Date.now() - 1000 * 30,
    updatedAt__to: Date.now(),
  };
  let granulesQueue = await granuleModel.granuleAttributeScan(searchParams);

  let fetchedGranules = await granulesQueue.empty();
  t.is(fetchedGranules.length, 3);
  t.deepEqual(
    fetchedGranules.map((g) => g.granuleId).sort(),
    granules.slice(0, 3).map((g) => g.granuleId).sort()
  );

  const searchWithGranId = {
    ...searchParams,
    granuleId: 'test',
  };

  granulesQueue = await granuleModel.granuleAttributeScan(searchWithGranId);
  fetchedGranules = await granulesQueue.empty();
  t.is(fetchedGranules.length, 1);

  const searchWithProvider = {
    ...searchParams,
    provider,
  };
  granulesQueue = await granuleModel.granuleAttributeScan(searchWithProvider);
  fetchedGranules = await granulesQueue.empty();
  t.is(fetchedGranules.length, 1);
});

test('removing a granule from CMR fails if the granule is not in CMR', async (t) => {
  const granule = fakeGranuleFactoryV2({ published: false });

  await awsServices.dynamodbDocClient().put({
    TableName: process.env.GranulesTable,
    Item: granule,
  }).promise();

  const granuleModel = new Granule();

  try {
    await granuleModel.removeGranuleFromCmrByGranule(granule);
  } catch (error) {
    t.is(error.message, `Granule ${granule.granuleId} is not published to CMR, so cannot be removed from CMR`);
  }
});

test.serial('removing a granule from CMR passes the granule UR to the cmr delete function', async (t) => {
  sinon.stub(
    DefaultProvider,
    'decrypt'
  ).callsFake(() => Promise.resolve('fakePassword'));

  sinon.stub(
    CMR.prototype,
    'deleteGranule'
  ).callsFake((granuleUr) => Promise.resolve(t.is(granuleUr, 'granule-ur')));

  sinon.stub(
    CMR.prototype,
    'getGranuleMetadata'
  ).callsFake(() => Promise.resolve({ title: 'granule-ur' }));

  try {
    const granule = fakeGranuleFactoryV2();

    await awsServices.dynamodbDocClient().put({
      TableName: process.env.GranulesTable,
      Item: granule,
    }).promise();

    const granuleModel = new Granule();

    await granuleModel.removeGranuleFromCmrByGranule(granule);
  } finally {
    CMR.prototype.deleteGranule.restore();
    DefaultProvider.decrypt.restore();
    CMR.prototype.getGranuleMetadata.restore();
  }
});

test.serial('removing a granule from CMR succeeds with Launchpad authentication', async (t) => {
  process.env.cmr_oauth_provider = 'launchpad';
  const launchpadStub = sinon.stub(launchpad, 'getLaunchpadToken').callsFake(() => randomString());

  sinon.stub(
    DefaultProvider,
    'decrypt'
  ).callsFake(() => Promise.resolve('fakePassword'));

  sinon.stub(
    CMR.prototype,
    'deleteGranule'
  ).callsFake((granuleUr) => Promise.resolve(t.is(granuleUr, 'granule-ur')));

  sinon.stub(
    CMR.prototype,
    'getGranuleMetadata'
  ).callsFake(() => Promise.resolve({ title: 'granule-ur' }));

  try {
    const granule = fakeGranuleFactoryV2();

    await awsServices.dynamodbDocClient().put({
      TableName: process.env.GranulesTable,
      Item: granule,
    }).promise();

    const granuleModel = new Granule();

    await granuleModel.removeGranuleFromCmrByGranule(granule);

    t.is(launchpadStub.calledOnce, true);
  } finally {
    process.env.cmr_oauth_provider = 'earthdata';
    launchpadStub.restore();
    CMR.prototype.deleteGranule.restore();
    DefaultProvider.decrypt.restore();
    CMR.prototype.getGranuleMetadata.restore();
  }
});

test.serial(
  'reingest pushes a message with the correct queueUrl',
  async (t) => {
    const { granuleModel } = t.context;
    const updateStatusStub = sinon.stub(granuleModel, 'updateStatus');
    const queueUrl = 'testqueueUrl';
    const granule = {
      execution: 'some/execution',
      collectionId: constructCollectionId('MyCollection', '006'),
      provider: 'someProvider',
      queueUrl,
    };
    const fileExists = () => Promise.resolve(true);
    const fileExistsStub = sinon.stub(s3Utils, 'fileExists').callsFake(fileExists);
    const buildPayloadSpy = sinon.stub(Rule, 'buildPayload');

    try {
      await granuleModel.reingest(granule);
      // Rule.buildPayload has its own unit tests to ensure the queue name
      // is used properly, so just ensure that we pass the correct argument
      // to that function.
      t.is(buildPayloadSpy.args[0][0].queueUrl, queueUrl);
    } finally {
      fileExistsStub.restore();
      buildPayloadSpy.restore();
      updateStatusStub.restore();
    }
  }
);

test('_getMutableFieldNames() returns correct fields for running status', (t) => {
  const { granuleModel } = t.context;

  const updatedItem = {
    granuleId: randomString(),
    status: 'running',
  };

  const updateFields = granuleModel._getMutableFieldNames(updatedItem);

  t.deepEqual(updateFields, [
    'createdAt', 'updatedAt', 'timestamp', 'status', 'execution',
  ]);
});

test('_getMutableFieldNames() returns correct fields for completed status', (t) => {
  const { granuleModel } = t.context;

  const item = {
    granuleId: randomString(),
    status: 'completed',
    pdrName: 'pdr',
    files: [],
    createdAt: Date.now(),
  };

  const updateFields = granuleModel._getMutableFieldNames(item);

  t.deepEqual(updateFields, Object.keys(item));
});

test('applyWorkflow throws error if workflow argument is missing', async (t) => {
  const { granuleModel } = t.context;

  const granule = {
    granuleId: randomString(),
  };

  await t.throwsAsync(
    granuleModel.applyWorkflow(granule),
    {
      instanceOf: TypeError,
    }
  );
});

test.serial('applyWorkflow invokes Lambda to schedule workflow', async (t) => {
  const { granuleModel } = t.context;

  const granule = fakeGranuleFactoryV2();
  const workflow = randomString();
  const lambdaPayload = {
    payload: {
      granules: [granule],
    },
  };

  await granuleModel.create(granule);

  const buildPayloadStub = sinon.stub(Rule, 'buildPayload').resolves(lambdaPayload);
  const lambdaInvokeStub = sinon.stub(Lambda, 'invoke').resolves();
  t.teardown(() => {
    buildPayloadStub.restore();
    lambdaInvokeStub.restore();
  });

  await granuleModel.applyWorkflow(granule, workflow);

  t.true(lambdaInvokeStub.called);
  t.deepEqual(lambdaInvokeStub.args[0][1], lambdaPayload);
});

test.serial('applyWorkflow uses custom queueUrl, if provided', async (t) => {
  const { granuleModel } = t.context;

  const granule = fakeGranuleFactoryV2();
  const workflow = randomString();
  const queueUrl = randomString();

  await granuleModel.create(granule);

  const buildPayloadStub = sinon.stub(Rule, 'buildPayload').resolves();
  const lambdaInvokeStub = sinon.stub(Lambda, 'invoke').resolves();
  t.teardown(() => {
    buildPayloadStub.restore();
    lambdaInvokeStub.restore();
  });

  await granuleModel.applyWorkflow(granule, workflow, undefined, queueUrl);

  t.true(buildPayloadStub.called);
  t.like(buildPayloadStub.args[0][0], {
    queueUrl,
  });
});
