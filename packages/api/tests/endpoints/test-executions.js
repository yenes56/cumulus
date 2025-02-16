'use strict';

const test = require('ava');
const omit = require('lodash/omit');
const sortBy = require('lodash/sortBy');
const request = require('supertest');
const uuidv4 = require('uuid/v4');
const {
  createBucket,
  recursivelyDeleteS3Bucket,
  s3PutObject,
} = require('@cumulus/aws-client/S3');
const { randomId } = require('@cumulus/common/test-utils');
const {
  CollectionPgModel,
  destroyLocalTestDb,
  ExecutionPgModel,
  fakeCollectionRecordFactory,
  fakeGranuleRecordFactory,
  generateLocalTestDb,
  GranulePgModel,
  localStackConnectionEnv,
  translateApiAsyncOperationToPostgresAsyncOperation,
  translateApiExecutionToPostgresExecution,
  translatePostgresExecutionToApiExecution,
  upsertGranuleWithExecutionJoinRecord,
  fakeExecutionRecordFactory,
  AsyncOperationPgModel,
  migrationDir,
} = require('@cumulus/db');
const { bootstrapElasticSearch } = require('@cumulus/es-client/bootstrap');
const indexer = require('@cumulus/es-client/indexer');
const { Search } = require('@cumulus/es-client/search');
const { constructCollectionId } = require('@cumulus/message/Collections');
const { AccessToken, AsyncOperation, Collection, Execution, Granule } = require('../../models');
// Dynamo mock data factories
const {
  createFakeJwtAuthToken,
  fakeCollectionFactory,
  fakeGranuleFactoryV2,
  fakeExecutionFactoryV2,
  setAuthorizedOAuthUsers,
  fakeAsyncOperationFactory,
} = require('../../lib/testUtils');
const assertions = require('../../lib/assertions');

// create all the variables needed across this test
let accessTokenModel;
let asyncOperationModel;
let asyncOperationPgModel;
let collectionModel;
let collectionPgModel;
let esClient;
let esIndex;
let executionModel;
let executionPgModel;
let granuleModel;
let granulePgModel;
let jwtAuthToken;
const fakeExecutions = [];
process.env.AccessTokensTable = randomId('token');
process.env.AsyncOperationsTable = randomId('asyncOperation');
process.env.CollectionsTable = randomId('collection');
process.env.ExecutionsTable = randomId('executions');
process.env.GranulesTable = randomId('granules');
process.env.stackName = randomId('stackname');
process.env.system_bucket = randomId('bucket');
process.env.TOKEN_SECRET = randomId('secret');

const testDbName = randomId('execution_test');

// import the express app after setting the env variables
const { app } = require('../../app');

test.before(async (t) => {
  process.env = {
    ...process.env,
    ...localStackConnectionEnv,
    PG_DATABASE: testDbName,
    METRICS_ES_HOST: 'fakehost',
    METRICS_ES_USER: randomId('metricsUser'),
    METRICS_ES_PASS: randomId('metricsPass'),
  };

  esIndex = randomId('esindex');
  t.context.esAlias = randomId('esAlias');
  process.env.ES_INDEX = t.context.esAlias;

  // create esClient
  esClient = await Search.es();

  // add fake elasticsearch index
  await bootstrapElasticSearch('fakehost', esIndex, t.context.esAlias);

  // create a fake bucket
  await createBucket(process.env.system_bucket);

  // create a workflow template file
  const tKey = `${process.env.stackName}/workflow_template.json`;
  await s3PutObject({
    Bucket: process.env.system_bucket,
    Key: tKey,
    Body: '{}',
  });

  // Generate a local test postGres database

  const { knex, knexAdmin } = await generateLocalTestDb(
    testDbName,
    migrationDir
  );
  t.context.knex = knex;
  t.context.knexAdmin = knexAdmin;

  // create fake AsyncOperation table
  asyncOperationModel = new AsyncOperation({
    systemBucket: process.env.system_bucket,
    stackName: process.env.stackName,
  });
  await asyncOperationModel.createTable();

  // create fake Collections table
  collectionModel = new Collection();
  await collectionModel.createTable();

  // create fake Granules table
  granuleModel = new Granule();
  await granuleModel.createTable();

  // create fake execution table
  executionModel = new Execution();
  await executionModel.createTable();

  // create fake execution records
  fakeExecutions.push(
    fakeExecutionFactoryV2({
      status: 'completed',
      asyncOperationId: '0fe6317a-233c-4f19-a551-f0f76071402f',
      arn: 'arn2',
      type: 'fakeWorkflow',
    })
  );
  fakeExecutions.push(
    fakeExecutionFactoryV2({ status: 'failed', type: 'workflow2' })
  );
  fakeExecutions.push(
    fakeExecutionFactoryV2({ status: 'running', type: 'fakeWorkflow' })
  );
  await Promise.all(
    fakeExecutions.map(async (i) =>
      await executionModel
        .create(i)
        .then(async (record) =>
          await indexer.indexExecution(esClient, record, t.context.esAlias)))
  );

  asyncOperationPgModel = new AsyncOperationPgModel();
  executionPgModel = new ExecutionPgModel();
  collectionPgModel = new CollectionPgModel();
  granulePgModel = new GranulePgModel();

  const username = randomId('username');
  await setAuthorizedOAuthUsers([username]);

  accessTokenModel = new AccessToken();
  await accessTokenModel.createTable();

  jwtAuthToken = await createFakeJwtAuthToken({ accessTokenModel, username });

  // Create AsyncOperation in Dynamo and Postgres
  const testAsyncOperation = fakeAsyncOperationFactory({
    id: uuidv4(),
    output: JSON.stringify({ test: randomId('output') }),
  });
  t.context.testAsyncOperation = await asyncOperationModel.create(
    testAsyncOperation
  );

  const testPgAsyncOperation = translateApiAsyncOperationToPostgresAsyncOperation(
    t.context.testAsyncOperation
  );

  [t.context.asyncOperationCumulusId] = await asyncOperationPgModel.create(
    knex,
    testPgAsyncOperation
  );

  // Create collections in Dynamo and Postgres
  // we need this because a granule has a foreign key referring to collections
  const collectionName = 'fakeCollection';
  const collectionVersion = 'v1';

  t.context.testCollection = fakeCollectionFactory({
    name: collectionName,
    version: collectionVersion,
    duplicateHandling: 'error',
  });
  const dynamoCollection = await collectionModel.create(
    t.context.testCollection
  );
  t.context.collectionId = constructCollectionId(
    dynamoCollection.name,
    dynamoCollection.version
  );

  const testPgCollection = fakeCollectionRecordFactory({
    name: collectionName,
    version: collectionVersion,
  });

  [t.context.collectionCumulusId] = await collectionPgModel.create(
    knex,
    testPgCollection
  );

  t.context.fakePGExecutions = await Promise.all(fakeExecutions.map(async (execution) => {
    const omitExecution = omit(execution, ['asyncOperationId', 'parentArn']);
    await executionModel.create(omitExecution);
    const executionPgRecord = await translateApiExecutionToPostgresExecution(
      omitExecution,
      knex
    );
    const executionCumulusIds = await executionPgModel.create(knex, executionPgRecord);
    return { ...executionPgRecord, cumulus_id: executionCumulusIds[0] };
  }));

  t.context.fakeApiExecutions = await Promise.all(t.context.fakePGExecutions
    .map(async (fakePGExecution) =>
      await translatePostgresExecutionToApiExecution(fakePGExecution)));

  await esClient.indices.refresh();
});

test.beforeEach(async (t) => {
  const { esAlias, knex } = t.context;

  const granuleId1 = randomId('granuleId1');
  const granuleId2 = randomId('granuleId2');

  // create fake Dynamo granule records
  t.context.fakeGranules = [
    fakeGranuleFactoryV2({ granuleId: granuleId1, status: 'completed', collectionId: t.context.collectionId }),
    fakeGranuleFactoryV2({ granuleId: granuleId2, status: 'failed', collectionId: t.context.collectionId }),
  ];

  await granuleModel.create(t.context.fakeGranules[0])
    .then(async (record) => await indexer.indexGranule(esClient, record, esAlias));
  await granuleModel.create(t.context.fakeGranules[1])
    .then(async (record) => await indexer.indexGranule(esClient, record, esAlias));

  // create fake Postgres granule records
  t.context.fakePGGranules = [
    fakeGranuleRecordFactory({
      granule_id: granuleId1,
      status: 'completed',
      collection_cumulus_id: t.context.collectionCumulusId,
    }),
    fakeGranuleRecordFactory({
      granule_id: granuleId2,
      status: 'failed',
      collection_cumulus_id: t.context.collectionCumulusId,
    }),
  ];

  [t.context.granuleCumulusId] = await Promise.all(
    t.context.fakePGGranules.map(async (granule) =>
      await granulePgModel.create(knex, granule))
  );

  await upsertGranuleWithExecutionJoinRecord(
    knex, t.context.fakePGGranules[0], await executionPgModel.getRecordCumulusId(knex, {
      workflow_name: 'fakeWorkflow',
      arn: 'arn2',
    })
  );
  await upsertGranuleWithExecutionJoinRecord(
    knex, t.context.fakePGGranules[0], await executionPgModel.getRecordCumulusId(knex, {
      workflow_name: 'workflow2',
    })
  );
  await upsertGranuleWithExecutionJoinRecord(
    knex, t.context.fakePGGranules[1], await executionPgModel.getRecordCumulusId(knex, {
      workflow_name: 'fakeWorkflow',
      status: 'running',
    })
  );
});

test.after.always(async (t) => {
  await accessTokenModel.deleteTable();
  await asyncOperationModel.deleteTable();
  await collectionModel.deleteTable();
  await executionModel.deleteTable();
  await granuleModel.deleteTable();
  await esClient.indices.delete({ index: esIndex });
  await recursivelyDeleteS3Bucket(process.env.system_bucket);

  await destroyLocalTestDb({
    knex: t.context.knex,
    knexAdmin: t.context.knexAdmin,
    testDbName,
  });
});

test.serial('CUMULUS-911 GET without pathParameters and without an Authorization header returns an Authorization Missing response', async (t) => {
  const response = await request(app)
    .get('/executions')
    .set('Accept', 'application/json')
    .expect(401);

  assertions.isAuthorizationMissingResponse(t, response);
});

test.serial('CUMULUS-911 GET with pathParameters and without an Authorization header returns an Authorization Missing response', async (t) => {
  const response = await request(app)
    .get('/executions/asdf')
    .set('Accept', 'application/json')
    .expect(401);

  assertions.isAuthorizationMissingResponse(t, response);
});

test.serial('CUMULUS-912 GET without pathParameters and with an unauthorized user returns an unauthorized response', async (t) => {
  const response = await request(app)
    .get('/executions')
    .set('Accept', 'application/json')
    .expect(401);

  assertions.isAuthorizationMissingResponse(t, response);
});

test.serial('CUMULUS-912 GET with pathParameters and with an unauthorized user returns an unauthorized response', async (t) => {
  const response = await request(app)
    .get('/executions/asdf')
    .set('Accept', 'application/json')
    .expect(401);

  assertions.isAuthorizationMissingResponse(t, response);
});

test.serial('GET executions returns list of executions by default', async (t) => {
  const response = await request(app)
    .get('/executions')
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(200);

  const { meta, results } = response.body;
  t.is(results.length, 3);
  t.is(meta.stack, process.env.stackName);
  t.is(meta.table, 'execution');
  t.is(meta.count, 3);
  const arns = fakeExecutions.map((i) => i.arn);
  results.forEach((r) => {
    t.true(arns.includes(r.arn));
  });
});

test.serial('executions can be filtered by workflow', async (t) => {
  const response = await request(app)
    .get('/executions')
    .query({ type: 'workflow2' })
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(200);

  const { meta, results } = response.body;
  t.is(results.length, 1);
  t.is(meta.stack, process.env.stackName);
  t.is(meta.table, 'execution');
  t.is(meta.count, 1);
  t.is(fakeExecutions[1].arn, results[0].arn);
});

test.serial('GET executions with asyncOperationId filter returns the correct executions', async (t) => {
  const response = await request(app)
    .get('/executions?asyncOperationId=0fe6317a-233c-4f19-a551-f0f76071402f')
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(200);

  t.is(response.body.meta.count, 1);
  t.is(response.body.results[0].arn, 'arn2');
});

test.serial('GET returns an existing execution', async (t) => {
  const response = await request(app)
    .get(`/executions/${fakeExecutions[0].arn}`)
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(200);

  const executionResult = response.body;
  t.is(executionResult.arn, fakeExecutions[0].arn);
  t.is(executionResult.name, fakeExecutions[0].name);
  t.truthy(executionResult.duration);
  t.is(executionResult.status, 'completed');
});

test.serial('GET fails if execution is not found', async (t) => {
  const response = await request(app)
    .get('/executions/unknown')
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(404);

  t.is(response.status, 404);
  t.true(response.body.message.includes('No record found for'));
});

test.serial('DELETE removes only specified execution from all data stores', async (t) => {
  const { knex } = t.context;

  const newExecution = fakeExecutionFactoryV2({
    arn: 'arn3',
    status: 'completed',
    name: 'test_execution',
  });

  await executionModel.create(newExecution);
  const executionPgRecord = await translateApiExecutionToPostgresExecution(
    newExecution,
    knex
  );
  await executionPgModel.create(knex, executionPgRecord);

  t.true(await executionModel.exists({ arn: newExecution.arn }));
  t.true(await executionPgModel.exists(knex, { arn: newExecution.arn }));

  await request(app)
    .delete(`/executions/${newExecution.arn}`)
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(200);

  // Correct Dynamo and PG execution was deleted
  t.false(await executionModel.exists({ arn: newExecution.arn }));

  const dbRecords = await executionPgModel.search(t.context.knex, {
    arn: newExecution.arn,
  });

  t.is(dbRecords.length, 0);

  // Previously created executions still exist
  t.true(await executionModel.exists({ arn: fakeExecutions[0].arn }));
  t.true(await executionModel.exists({ arn: fakeExecutions[1].arn }));

  const originalExecution1 = await executionPgModel.search(t.context.knex, {
    arn: fakeExecutions[0].arn,
  });

  t.is(originalExecution1.length, 1);

  const originalExecution2 = await executionPgModel.search(t.context.knex, {
    arn: fakeExecutions[1].arn,
  });

  t.is(originalExecution2.length, 1);
});

test.serial('DELETE returns a 404 if Dynamo execution cannot be found', async (t) => {
  const nonExistantExecution = {
    arn: 'arn9',
    status: 'completed',
    name: 'test_execution',
  };

  const response = await request(app)
    .delete(`/executions/${nonExistantExecution.arn}`)
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(404);

  t.is(response.body.message, 'No record found');
});

test.serial('POST /executions/search-by-granules returns 1 record by default', async (t) => {
  const { fakeGranules, fakePGExecutions } = t.context;

  const response = await request(app)
    .post('/executions/search-by-granules')
    .send({ granules: [
      { granuleId: fakeGranules[0].granuleId, collectionId: t.context.collectionId },
      { granuleId: fakeGranules[1].granuleId, collectionId: t.context.collectionId },
    ] })
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`);

  t.is(response.body.results.length, 1);

  response.body.results.forEach(async (execution) => t.deepEqual(
    execution,
    await translatePostgresExecutionToApiExecution(fakePGExecutions
      .find((fakePGExecution) => fakePGExecution.arn === execution.arn))
  ));
});

test.serial('POST /executions/search-by-granules supports paging', async (t) => {
  const { fakeGranules, fakeApiExecutions } = t.context;

  const page1 = await request(app)
    .post('/executions/search-by-granules?limit=2&page=1')
    .send({ granules: [
      { granuleId: fakeGranules[0].granuleId, collectionId: t.context.collectionId },
      { granuleId: fakeGranules[1].granuleId, collectionId: t.context.collectionId },
    ] })
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`);

  const page2 = await request(app)
    .post('/executions/search-by-granules?limit=2&page=2')
    .send({ granules: [
      { granuleId: fakeGranules[0].granuleId, collectionId: t.context.collectionId },
      { granuleId: fakeGranules[1].granuleId, collectionId: t.context.collectionId },
    ] })
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`);

  t.is(page1.body.results.length, 2);
  t.is(page2.body.results.length, 1);

  const response = page1.body.results.concat(page2.body.results);

  response.forEach((execution) => t.deepEqual(
    execution,
    fakeApiExecutions.find((fakeAPIExecution) => fakeAPIExecution.arn === execution.arn)
  ));
});

test.serial('POST /executions/search-by-granules supports sorting', async (t) => {
  const { fakeGranules, fakeApiExecutions } = t.context;

  const response = await request(app)
    .post('/executions/search-by-granules?sort_by=arn&order=asc&limit=10')
    .send({ granules: [
      { granuleId: fakeGranules[0].granuleId, collectionId: t.context.collectionId },
      { granuleId: fakeGranules[1].granuleId, collectionId: t.context.collectionId },
    ] })
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`);

  const sortedApiExecutions = sortBy(fakeApiExecutions, ['arn']);

  t.deepEqual(response.body.results, sortedApiExecutions);
});

test.serial('POST /executions/search-by-granules returns correct executions when granules array is passed', async (t) => {
  const { fakeGranules, fakePGExecutions } = t.context;

  const response = await request(app)
    .post('/executions/search-by-granules?limit=10')
    .send({ granules: [
      { granuleId: fakeGranules[0].granuleId, collectionId: t.context.collectionId },
      { granuleId: fakeGranules[1].granuleId, collectionId: t.context.collectionId },
    ] })
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`);

  t.is(response.body.results.length, 3);

  response.body.results.forEach(async (execution) => t.deepEqual(
    execution,
    await translatePostgresExecutionToApiExecution(fakePGExecutions
      .find((fakePGExecution) => fakePGExecution.arn === execution.arn))
  ));
});

test.serial('POST /executions/search-by-granules returns correct executions when query is passed', async (t) => {
  const { fakeGranules, fakePGExecutions } = t.context;

  const expectedQuery = {
    size: 2,
    query: {
      bool: {
        filter: [
          {
            bool: {
              should: [{ match: { granuleId: fakeGranules[0].granuleId } }],
              minimum_should_match: 1,
            },
          },
          {
            bool: {
              should: [{ match: { collectionId: fakeGranules[0].collectionId } }],
              minimum_should_match: 1,
            },
          },
        ],
      },
    },
  };

  const body = {
    index: esIndex,
    query: expectedQuery,
  };

  const response = await request(app)
    .post('/executions/search-by-granules?limit=10')
    .send(body)
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`);

  t.is(response.body.results.length, 2);

  response.body.results.forEach(async (execution) => t.deepEqual(
    execution,
    await translatePostgresExecutionToApiExecution(fakePGExecutions
      .find((fakePGExecution) => fakePGExecution.arn === execution.arn))
  ));
});

test.serial('POST /executions/search-by-granules returns 400 when a query is provided with no index', async (t) => {
  const expectedQuery = { query: 'fake-query' };

  const body = {
    query: expectedQuery,
  };

  const response = await request(app)
    .post('/executions/search-by-granules')
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .send(body)
    .expect(400);

  t.regex(response.body.message, /Index is required if query is sent/);
});

test.serial('POST /executions/search-by-granules returns 400 when no granules or query is provided', async (t) => {
  const expectedIndex = 'my-index';

  const body = {
    index: expectedIndex,
  };

  const response = await request(app)
    .post('/executions/search-by-granules')
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .send(body)
    .expect(400, /One of granules or query is required/);

  t.regex(response.body.message, /One of granules or query is required/);
});

test.serial('POST /executions/search-by-granules returns 400 when granules is not an array', async (t) => {
  const expectedIndex = 'my-index';

  const body = {
    index: expectedIndex,
    granules: 'bad-value',
  };

  const response = await request(app)
    .post('/executions/search-by-granules')
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .send(body)
    .expect(400);

  t.regex(response.body.message, /granules should be an array of values/);
});

test.serial('POST /executions/search-by-granules returns 400 when granules is an empty array', async (t) => {
  const expectedIndex = 'my-index';

  const body = {
    index: expectedIndex,
    granules: [],
  };

  const response = await request(app)
    .post('/executions/search-by-granules')
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .send(body)
    .expect(400);

  t.regex(response.body.message, /no values provided for granules/);
});

test.serial('POST /executions/search-by-granules returns 400 when granules do not have collectionId', async (t) => {
  const expectedIndex = 'my-index';
  const granule = { granuleId: randomId('granuleId') };

  const body = {
    index: expectedIndex,
    granules: [granule],
  };

  const response = await request(app)
    .post('/executions/search-by-granules')
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .send(body)
    .expect(400);

  t.regex(response.body.message, new RegExp(`no collectionId provided for ${JSON.stringify(granule)}`));
});

test.serial('POST /executions/search-by-granules returns 400 when granules do not have granuleId', async (t) => {
  const expectedIndex = 'my-index';
  const granule = { collectionId: randomId('granuleId') };

  const body = {
    index: expectedIndex,
    granules: [granule],
  };

  const response = await request(app)
    .post('/executions/search-by-granules')
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .send(body)
    .expect(400);

  t.regex(response.body.message, new RegExp(`no granuleId provided for ${JSON.stringify(granule)}`));
});

test.serial('POST /executions/search-by-granules returns 400 when the Metrics ELK stack is not configured', async (t) => {
  const expectedIndex = 'my-index';
  const expectedQuery = { query: 'fake-query' };

  const body = {
    index: expectedIndex,
    query: expectedQuery,
  };

  const metricsUser = process.env.METRICS_ES_USER;
  delete process.env.METRICS_ES_USER;
  t.teardown(() => {
    process.env.METRICS_ES_USER = metricsUser;
  });

  const response = await request(app)
    .post('/executions/search-by-granules')
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .send(body)
    .expect(400);

  t.regex(response.body.message, /ELK Metrics stack not configured/);
});

test.serial('POST /executions/workflows-by-granules returns correct executions when granules array is passed', async (t) => {
  const { collectionId, fakeGranules, fakePGExecutions } = t.context;

  const response = await request(app)
    .post('/executions/workflows-by-granules')
    .send({ granules: [
      { granuleId: fakeGranules[0].granuleId, collectionId },
      { granuleId: fakeGranules[1].granuleId, collectionId },
    ] })
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`);

  t.is(response.body.length, 1);

  response.body.forEach((workflow) => t.deepEqual(
    workflow,
    fakePGExecutions
      .map((fakePGExecution) => fakePGExecution.workflow_name)
      .find((workflowName) => workflowName === workflow)
  ));
});

test.serial('POST /executions/workflows-by-granules returns executions by descending timestamp when a single granule is passed', async (t) => {
  const { knex, collectionId, fakeGranules, fakePGGranules } = t.context;

  const [mostRecentExecutionCumulusId]
    = await executionPgModel.create(knex, fakeExecutionRecordFactory({ workflow_name: 'newWorkflow' }));

  await upsertGranuleWithExecutionJoinRecord(
    knex, fakePGGranules[0], mostRecentExecutionCumulusId
  );

  const response = await request(app)
    .post('/executions/workflows-by-granules')
    .send({ granules: [
      { granuleId: fakeGranules[0].granuleId, collectionId },
    ] })
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`);

  t.is(response.body.length, 3);
  // newWorkflow should be the first result since it is most recent
  t.is(response.body[0], 'newWorkflow');
});

test.serial('POST /executions/workflows-by-granules returns correct workflows when query is passed', async (t) => {
  const { fakeGranules } = t.context;

  const expectedQuery = {
    size: 2,
    query: {
      bool: {
        filter: [
          {
            bool: {
              should: [{ match: { granuleId: fakeGranules[0].granuleId } }],
              minimum_should_match: 1,
            },
          },
          {
            bool: {
              should: [{ match: { collectionId: fakeGranules[0].collectionId } }],
              minimum_should_match: 1,
            },
          },
        ],
      },
    },
  };

  const body = {
    index: esIndex,
    query: expectedQuery,
  };

  const response = await request(app)
    .post('/executions/workflows-by-granules')
    .send(body)
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`);

  t.is(response.body.length, 2);

  t.deepEqual(response.body.sort(), ['fakeWorkflow', 'workflow2']);
});

test.serial('POST /executions creates a new execution in Dynamo and PG with correct timestamps', async (t) => {
  const newExecution = fakeExecutionFactoryV2();

  await request(app)
    .post('/executions')
    .send(newExecution)
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(200);

  const fetchedDynamoRecord = await executionModel.get({
    arn: newExecution.arn,
  });

  const fetchedPgRecord = await executionPgModel.get(
    t.context.knex,
    {
      arn: newExecution.arn,
    }
  );

  t.true(fetchedDynamoRecord.createdAt > newExecution.createdAt);
  t.true(fetchedDynamoRecord.updatedAt > newExecution.updatedAt);

  // PG and Dynamo records have the same timestamps
  t.is(fetchedPgRecord.created_at.getTime(), fetchedDynamoRecord.createdAt);
  t.is(fetchedPgRecord.updated_at.getTime(), fetchedDynamoRecord.updatedAt);
});

test.serial('POST /executions creates the expected record', async (t) => {
  const newExecution = fakeExecutionFactoryV2({
    asyncOperationId: t.context.testAsyncOperation.id,
    collectionId: t.context.collectionId,
    parentArn: t.context.fakeApiExecutions[1].arn,
  });

  const expectedPgRecord = await translateApiExecutionToPostgresExecution(
    newExecution,
    t.context.knex
  );

  await request(app)
    .post('/executions')
    .send(newExecution)
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(200);

  const fetchedDynamoRecord = await executionModel.get({
    arn: newExecution.arn,
  });

  const fetchedPgRecord = await executionPgModel.get(
    t.context.knex,
    {
      arn: newExecution.arn,
    }
  );

  t.is(fetchedPgRecord.arn, fetchedDynamoRecord.arn);
  t.truthy(fetchedPgRecord.cumulus_id);
  t.is(fetchedPgRecord.async_operation_cumulus_id, t.context.asyncOperationCumulusId);
  t.is(fetchedPgRecord.collection_cumulus_id, t.context.collectionCumulusId);
  t.is(fetchedPgRecord.parent_cumulus_id, t.context.fakePGExecutions[1].cumulus_id);

  const omitList = ['createdAt', 'updatedAt', 'created_at', 'updated_at', 'cumulus_id'];
  t.deepEqual(
    omit(fetchedDynamoRecord, omitList),
    omit(newExecution, omitList)
  );
  t.deepEqual(
    omit(fetchedPgRecord, omitList),
    omit(expectedPgRecord, omitList)
  );
});

test.serial('POST /executions throws error when "arn" is not provided', async (t) => {
  const newExecution = fakeExecutionFactoryV2();
  delete newExecution.arn;

  const response = await request(app)
    .post('/executions')
    .send(newExecution)
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(400);

  const expectedErrorMessage = 'Field arn is missing';
  t.truthy(response.body.message.match(expectedErrorMessage));
});

test.serial('POST /executions throws error when the provided execution already exists', async (t) => {
  const existingArn = t.context.fakeApiExecutions[1].arn;
  const newExecution = fakeExecutionFactoryV2({
    arn: existingArn,
  });

  const response = await request(app)
    .post('/executions')
    .send(newExecution)
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(409);

  const expectedErrorMessage = `A record already exists for ${newExecution.arn}`;
  t.truthy(response.body.message.match(expectedErrorMessage));
});

test.serial('POST /executions with non-existing asyncOperation throws error', async (t) => {
  const newExecution = fakeExecutionFactoryV2({
    asyncOperationId: uuidv4(),
    collectionId: t.context.collectionId,
    parentArn: t.context.fakeApiExecutions[1].arn,
  });

  const response = await request(app)
    .post('/executions')
    .send(newExecution)
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(400);

  const expectedErrorMessage = `Record in async_operations .*${newExecution.asyncOperationId}.* does not exist`;
  t.truthy(response.body.message.match(expectedErrorMessage));
});

test.serial('POST /executions with non-existing collectionId throws error', async (t) => {
  const newExecution = fakeExecutionFactoryV2({
    asyncOperationId: t.context.testAsyncOperation.id,
    collectionId: constructCollectionId(randomId('name'), randomId('version')),
    parentArn: t.context.fakeApiExecutions[1].arn,
  });

  const response = await request(app)
    .post('/executions')
    .send(newExecution)
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(400);

  const expectedErrorMessage = 'Record in collections with identifiers .* does not exist';
  t.truthy(response.body.message.match(expectedErrorMessage));
});

test.serial('POST /executions with non-existing parentArn still creates a new execution', async (t) => {
  const newExecution = fakeExecutionFactoryV2({
    asyncOperationId: t.context.testAsyncOperation.id,
    collectionId: t.context.collectionId,
    parentArn: randomId('parentArn'),
  });

  await request(app)
    .post('/executions')
    .send(newExecution)
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(200);

  const fetchedDynamoRecord = await executionModel.get({
    arn: newExecution.arn,
  });

  const fetchedPgRecord = await executionPgModel.get(
    t.context.knex,
    {
      arn: newExecution.arn,
    }
  );

  t.is(fetchedPgRecord.arn, fetchedDynamoRecord.arn);
  t.falsy(fetchedPgRecord.parent_cumulus_id);
});

test.serial('POST /executions creates an execution that is searchable', async (t) => {
  const newExecution = fakeExecutionFactoryV2();

  await request(app)
    .post('/executions')
    .send(newExecution)
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(200);

  const response = await request(app)
    .get('/executions')
    .query({ arn: newExecution.arn })
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(200);

  const { meta, results } = response.body;
  t.is(results.length, 1);
  t.is(meta.stack, process.env.stackName);
  t.is(meta.table, 'execution');
  t.is(meta.count, 1);
  t.is(results[0].arn, newExecution.arn);
});

test.serial('PUT /executions updates the record as expected', async (t) => {
  const execution = fakeExecutionFactoryV2({
    collectionId: t.context.collectionId,
    parentArn: t.context.fakeApiExecutions[1].arn,
    status: 'running',
  });
  delete execution.finalPayload;

  const updatedExecution = fakeExecutionFactoryV2({
    ...omit(execution, ['collectionId']),
    asyncOperationId: t.context.testAsyncOperation.id,
    finalPayload: { outputPayload: randomId('outputPayload') },
    parentArn: t.context.fakeApiExecutions[2].arn,
    status: 'completed',
  });

  await request(app)
    .post('/executions')
    .send(execution)
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(200);

  const dynamoRecord = await executionModel.get({
    arn: execution.arn,
  });

  const pgRecord = await executionPgModel.get(
    t.context.knex,
    {
      arn: execution.arn,
    }
  );

  await request(app)
    .put(`/executions/${updatedExecution.arn}`)
    .send(updatedExecution)
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(200);

  const updatedDynamoRecord = await executionModel.get({
    arn: execution.arn,
  });

  const updatePgRecord = await executionPgModel.get(
    t.context.knex,
    {
      arn: execution.arn,
    }
  );

  t.is(updatedDynamoRecord.arn, execution.arn);
  t.is(updatePgRecord.arn, execution.arn);
  t.is(updatePgRecord.cumulus_id, pgRecord.cumulus_id);

  t.is(updatedDynamoRecord.createdAt, dynamoRecord.createdAt);
  t.true(updatedDynamoRecord.updatedAt > dynamoRecord.createdAt);
  t.is(updatePgRecord.created_at.getTime(), pgRecord.created_at.getTime());
  t.true(updatePgRecord.updated_at.getTime() > pgRecord.updated_at.getTime());

  // updated record is the merge of the original record with the updated fields
  // updated record has the original info that's not updated
  t.is(updatedDynamoRecord.collectionId, execution.collectionId);
  t.is(updatePgRecord.collection_cumulus_id, t.context.collectionCumulusId);
  // updated record has added field
  t.is(updatedDynamoRecord.asyncOperationId, updatedExecution.asyncOperationId);
  t.is(updatePgRecord.async_operation_cumulus_id, t.context.asyncOperationCumulusId);
  // updated record has updated field
  t.is(updatedDynamoRecord.parentArn, updatedExecution.parentArn);
  t.is(updatePgRecord.parent_cumulus_id, t.context.fakePGExecutions[2].cumulus_id);
  t.is(updatedDynamoRecord.status, updatedExecution.status);
  t.is(updatePgRecord.status, updatedExecution.status);
  t.deepEqual(updatedDynamoRecord.finalPayload, updatedExecution.finalPayload);
  t.deepEqual(updatePgRecord.final_payload, updatedExecution.finalPayload);
});

test.serial('PUT /executions throws error for arn mismatch between params and payload', async (t) => {
  const updatedExecution = fakeExecutionFactoryV2();
  const arn = randomId('arn');
  const response = await request(app)
    .put(`/executions/${arn}`)
    .send(updatedExecution)
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(400);

  const expectedErrorMessage = `Expected execution arn to be '${arn}`;
  t.truthy(response.body.message.match(expectedErrorMessage));
});

test.serial('PUT /executions throws error when the provided execution does not exist', async (t) => {
  const updatedExecution = fakeExecutionFactoryV2();

  const response = await request(app)
    .put(`/executions/${updatedExecution.arn}`)
    .send(updatedExecution)
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(404);

  const expectedErrorMessage = `Execution '${updatedExecution.arn}' not found`;
  t.truthy(response.body.message.match(expectedErrorMessage));
});

test.serial('PUT /executions with non-existing asyncOperation throws error', async (t) => {
  const execution = fakeExecutionFactoryV2();

  const updatedExecution = fakeExecutionFactoryV2({
    ...execution,
    asyncOperationId: uuidv4(),
  });

  await request(app)
    .post('/executions')
    .send(execution)
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(200);

  const response = await request(app)
    .put(`/executions/${updatedExecution.arn}`)
    .send(updatedExecution)
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(400);

  const expectedErrorMessage = `Record in async_operations .*${updatedExecution.asyncOperationId}.* does not exist`;
  t.truthy(response.body.message.match(expectedErrorMessage));
});

test.serial('PUT /executions with non-existing collectionId throws error', async (t) => {
  const execution = fakeExecutionFactoryV2();

  const updatedExecution = fakeExecutionFactoryV2({
    ...execution,
    collectionId: constructCollectionId(randomId('name'), randomId('version')),
  });

  await request(app)
    .post('/executions')
    .send(execution)
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(200);

  const response = await request(app)
    .put(`/executions/${updatedExecution.arn}`)
    .send(updatedExecution)
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(400);

  const expectedErrorMessage = 'Record in collections with identifiers .* does not exist';
  t.truthy(response.body.message.match(expectedErrorMessage));
});

test.serial('PUT /executions with non-existing parentArn still updates the execution', async (t) => {
  const execution = fakeExecutionFactoryV2();
  const updatedExecution = fakeExecutionFactoryV2({
    ...execution,
    parentArn: randomId('parentArn'),
  });

  await request(app)
    .post('/executions')
    .send(execution)
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(200);

  await request(app)
    .put(`/executions/${updatedExecution.arn}`)
    .send(updatedExecution)
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(200);

  const fetchedDynamoRecord = await executionModel.get({
    arn: updatedExecution.arn,
  });

  const fetchedPgRecord = await executionPgModel.get(
    t.context.knex,
    {
      arn: updatedExecution.arn,
    }
  );

  t.is(fetchedPgRecord.arn, fetchedDynamoRecord.arn);
  t.falsy(fetchedPgRecord.parent_cumulus_id);
});
