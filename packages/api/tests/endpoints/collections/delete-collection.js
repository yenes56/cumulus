'use strict';

const test = require('ava');
const request = require('supertest');
const awsServices = require('@cumulus/aws-client/services');
const {
  recursivelyDeleteS3Bucket,
} = require('@cumulus/aws-client/S3');
const { randomString } = require('@cumulus/common/test-utils');
const {
  localStackConnectionEnv,
  generateLocalTestDb,
  destroyLocalTestDb,
  CollectionPgModel,
  migrationDir,
} = require('@cumulus/db');
const { bootstrapElasticSearch } = require('@cumulus/es-client/bootstrap');
const { Search } = require('@cumulus/es-client/search');

const models = require('../../../models');
const {
  fakeCollectionFactory,
  createFakeJwtAuthToken,
  setAuthorizedOAuthUsers,
} = require('../../../lib/testUtils');
const assertions = require('../../../lib/assertions');
const { fakeRuleFactoryV2 } = require('../../../lib/testUtils');
const { dynamoRecordToDbRecord } = require('../../../endpoints/collections');

process.env.AccessTokensTable = randomString();
process.env.CollectionsTable = randomString();
process.env.stackName = randomString();
process.env.system_bucket = randomString();
process.env.TOKEN_SECRET = randomString();

// import the express app after setting the env variables
const { app } = require('../../../app');

const esIndex = randomString();
let esClient;

let jwtAuthToken;
let accessTokenModel;
let collectionModel;
let ruleModel;

const testDbName = randomString(12);

test.before(async (t) => {
  process.env = {
    ...process.env,
    ...localStackConnectionEnv,
    PG_DATABASE: testDbName,
  };

  const { knex, knexAdmin } = await generateLocalTestDb(testDbName, migrationDir);
  t.context.testKnex = knex;
  t.context.testKnexAdmin = knexAdmin;

  t.context.collectionPgModel = new CollectionPgModel();

  const esAlias = randomString();
  process.env.ES_INDEX = esAlias;
  await bootstrapElasticSearch('fakehost', esIndex, esAlias);

  await awsServices.s3().createBucket({ Bucket: process.env.system_bucket }).promise();

  collectionModel = new models.Collection({ tableName: process.env.CollectionsTable });
  await collectionModel.createTable();

  const username = randomString();
  await setAuthorizedOAuthUsers([username]);

  accessTokenModel = new models.AccessToken();
  await accessTokenModel.createTable();

  jwtAuthToken = await createFakeJwtAuthToken({ accessTokenModel, username });

  esClient = await Search.es('fakehost');

  process.env.RulesTable = randomString();
  ruleModel = new models.Rule();
  await ruleModel.createTable();

  await awsServices.s3().putObject({
    Bucket: process.env.system_bucket,
    Key: `${process.env.stackName}/workflow_template.json`,
    Body: JSON.stringify({}),
  }).promise();
});

test.beforeEach(async (t) => {
  t.context.testCollection = fakeCollectionFactory();
  await collectionModel.create(t.context.testCollection);
});

test.after.always(async (t) => {
  await accessTokenModel.deleteTable();
  await collectionModel.deleteTable();
  await recursivelyDeleteS3Bucket(process.env.system_bucket);
  await esClient.indices.delete({ index: esIndex });
  await ruleModel.deleteTable();
  await destroyLocalTestDb({
    knex: t.context.testKnex,
    knexAdmin: t.context.testKnexAdmin,
    testDbName,
  });
});

test('Attempting to delete a collection without an Authorization header returns an Authorization Missing response', async (t) => {
  const { testCollection } = t.context;
  const response = await request(app)
    .delete(`/collections/${testCollection.name}/${testCollection.version}`)
    .set('Accept', 'application/json')
    .expect(401);

  t.is(response.status, 401);
  t.true(
    await collectionModel.exists(
      testCollection.name,
      testCollection.version
    )
  );
});

test('Attempting to delete a collection with an invalid access token returns an unauthorized response', async (t) => {
  const response = await request(app)
    .delete('/collections/asdf/asdf')
    .set('Accept', 'application/json')
    .set('Authorization', 'Bearer ThisIsAnInvalidAuthorizationToken')
    .expect(401);

  assertions.isInvalidAccessTokenResponse(t, response);
});

test.todo('Attempting to delete a collection with an unauthorized user returns an unauthorized response');

test('Deleting a collection removes it', async (t) => {
  const collection = fakeCollectionFactory();
  const createdCollectionRecord = await collectionModel.create(collection);

  const dbRecord = dynamoRecordToDbRecord(createdCollectionRecord);
  await t.context.collectionPgModel.create(t.context.testKnex, dbRecord);

  await request(app)
    .delete(`/collections/${collection.name}/${collection.version}`)
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(200);

  const response = await request(app)
    .get(`/collections/${collection.name}/${collection.version}`)
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(404);

  t.is(response.status, 404);

  t.false(await t.context.collectionPgModel.exists(t.context.testKnex, {
    name: collection.name,
    version: collection.version,
  }));
});

test('Deleting a collection without a record in RDS succeeds', async (t) => {
  const collection = fakeCollectionFactory();
  await collectionModel.create(collection);

  await request(app)
    .delete(`/collections/${collection.name}/${collection.version}`)
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(200);

  const response = await request(app)
    .get(`/collections/${collection.name}/${collection.version}`)
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(404);

  t.is(response.status, 404);
});

test('Attempting to delete a collection with an associated rule returns a 409 response', async (t) => {
  const collection = fakeCollectionFactory();
  await collectionModel.create(collection);

  const rule = fakeRuleFactoryV2({
    collection: {
      name: collection.name,
      version: collection.version,
    },
    rule: {
      type: 'onetime',
    },
  });

  // The workflow message template must exist in S3 before the rule can be created
  await awsServices.s3().putObject({
    Bucket: process.env.system_bucket,
    Key: `${process.env.stackName}/workflows/${rule.workflow}.json`,
    Body: JSON.stringify({}),
  }).promise();

  const ruleWithTrigger = await ruleModel.createRuleTrigger(rule);
  await ruleModel.create(ruleWithTrigger);

  const response = await request(app)
    .delete(`/collections/${collection.name}/${collection.version}`)
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(409);

  t.is(response.status, 409);
  t.is(response.body.message, `Cannot delete collection with associated rules: ${rule.name}`);
});

test('Attempting to delete a collection with an associated rule does not delete the provider', async (t) => {
  const collection = fakeCollectionFactory();
  await collectionModel.create(collection);

  const rule = fakeRuleFactoryV2({
    collection: {
      name: collection.name,
      version: collection.version,
    },
    rule: {
      type: 'onetime',
    },
  });

  // The workflow message template must exist in S3 before the rule can be created
  await awsServices.s3().putObject({
    Bucket: process.env.system_bucket,
    Key: `${process.env.stackName}/workflows/${rule.workflow}.json`,
    Body: JSON.stringify({}),
  }).promise();

  const ruleWithTrigger = await ruleModel.createRuleTrigger(rule);
  await ruleModel.create(ruleWithTrigger);

  await request(app)
    .delete(`/collections/${collection.name}/${collection.version}`)
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(409);

  t.true(await collectionModel.exists(collection.name, collection.version));
});
