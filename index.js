const crypto = require('crypto');
const express = require('express');
const orderBy = require('lodash.orderby');

const counts = {
  apps: process.env.APPS_COUNT || 1,
  organizations: process.env.ORGANIZATIONS_COUNT || 1,
  spaces: process.env.SPACES_COUNT || 1,
  user_roles: process.env.USER_ROLES_COUNT || 1
};

const state = {
  apps: {},
  organizations: {},
  private_domains: {},
  processes: {},
  quota_definitions: {},
  routes: {},
  service_instances: {},
  services: {},
  shared_domains: {},
  spaces: {},
  stacks: {},
  user_provided_service_instances: {},
  user_roles: {},
  tasks: {}
};

const filters = {
  apps: ({organization_guids, space_guids}) => ({space_guid}) =>
    (!organization_guids || organization_guids.split(',').indexOf(state.spaces[space_guid].organization_guid) !== -1) &&
    (!space_guids || space_guids.split(',').indexOf(space_guid) !== -1),
  processes: ({organization_guids, space_guids}) => ({app_guid, space_guid}) =>
    (!organization_guids || organization_guids.split(',').indexOf(state.spaces[space_guid].organization_guid) !== -1) &&
    (!space_guids || space_guids.split(',').indexOf(space_guid) !== -1),
  tasks: ({organization_guids, space_guids, app_guids}) => ({app_guid}) =>
    (!organization_guids || organization_guids.split(',').indexOf(state.spaces[state.apps[app_guid].space_guid].organization_guid) !== -1) &&
    (!space_guids || space_guids.split(',').indexOf(state.apps[app_guid].space_guid) !== -1) &&
    (!app_guids || app_guids.split(',').indexOf(app_guid) !== -1)
};

const newGuid = () => {
  const guid = crypto.randomBytes(16).toString('hex');
  return `${guid.substr(0, 8)}-${guid.substr(8, 4)}-${guid.substr(12, 4)}-${guid.substr(16, 4)}-${guid.substr(20, 12)}`;
};
const name = type => `${type}-${crypto.randomBytes(4).toString('hex')}`;
const randomValue = arr => arr[Math.floor(Math.random() * arr.length)];

const quotaDefinitionGuid = newGuid();
state.quota_definitions[quotaDefinitionGuid] = {
  guid: quotaDefinitionGuid,
  name: name('quota_definition'),
  non_basic_services_allowed: true,
  memory_limit: 10 * 1024 * 1024
};

for (let i = 0; i < counts.organizations; i++) {
  const guid = newGuid();
  state.organizations[guid] = {guid, name: name('org'), quota_definition_guid: quotaDefinitionGuid};
}
const organizationGuids = Object.keys(state.organizations);

for (let i = 0; i < counts.spaces; i++) {
  const guid = newGuid();
  state.spaces[guid] = {guid, name: name('space'), organization_guid: randomValue(organizationGuids)};
}
const spaceGuids = Object.keys(state.spaces);

for (let i = 0; i < counts.apps; i++) {
  const guid = newGuid();
  state.apps[guid] = {guid, name: name('app'), space_guid: randomValue(spaceGuids), state: 'STARTED'};
  state.processes[guid] = {guid, type: 'web', app_guid: guid, space_guid: state.apps[guid].space_guid};
}

for (let i = 0; i < counts.user_roles; i++) {
  const guid = newGuid();
  state.user_roles[guid] = {
    guid,
    admin: true,
    active: true,
    default_space_guid: randomValue(spaceGuids),
    username: name('app'),
    organization_roles: ['org_user', 'org_manager', 'org_auditor', 'billing_manager']
  };
}

const identity = a => a;
const parentFilter = (obj, parentType, parentGuid) => !parentType || obj[`${parentType.replace(/s$/, '')}_guid`] === parentGuid;
const v2Filter = (obj, q) => {
  if (!q) return true;
  const [filter, op, value] = q;
  if (op === ':') return obj[filter] === value;
  if (op === ' IN ') return value.split(',').indexOf(obj[filter]) !== -1;
  if (op === '<') return obj[filter] < value;
  if (op === '<=') return obj[filter] <= value;
  if (op === '>') return obj[filter] > value;
  if (op === '>=') return obj[filter] >= value;
};
const v2Resource = type => ({guid, ...rest}) => ({metadata: {guid, url: `/v2/${type}/${guid}`}, entity: {...rest}});

const newPage = ({parentType, type}, {filter = identity, page = 1, perPage = 50, by, dir = 'asc'}, mapper) => {
  page = Math.max(1, page);
  perPage = Math.max(1, Math.min(100, perPage));
  dir = dir === 'desc' ? 'desc' : 'asc';
  const matches = Object.values(state[type]).filter(filter);
  const total_results = matches.length;
  const total_pages = Math.ceil(total_results / perPage);
  const begin = (page - 1) * perPage;
  const end = begin + perPage;
  const resources = orderBy(matches, by, dir).slice(begin, end).map(mapper);
  return {total_results, total_pages, resources};
};

const Capi = {
  v2: {
    page: ({params, params: {parentType, parentGuid, type}, query: {q, page, 'results-per-page': perPage, 'order-by': by, 'order-direction': dir}}) =>
      newPage(params, {
        filter: obj => parentFilter(obj, parentType, parentGuid) && v2Filter(obj, q),
        page,
        perPage,
        by,
        dir
      }, v2Resource(type)),
    resource: ({params: {type, guid}}) => v2Resource(type)(state[type][guid])
  },
  v3: {
    page: ({params, params: {type}, query, query: {page, per_page: perPage, order_by: by = ''}}) => {
      const {total_results, total_pages, resources} = newPage(params, {
        filter: typeof filters[type] === 'function' && filters[type](query),
        page,
        perPage,
        by: by.replace('^-', ''),
        dir: by.indexOf('-') === 0 ? 'desc' : 'asc'
      }, identity);
      return {pagination: {total_results, total_pages}, resources};
    },
    resource: ({params: {type, guid}}) => state[type][guid]
  }
};

const featureFlag = name => ({name, enabled: true});
const memoryUsage = {memory_usage_in_mb: 1024 * 1024};
const send = method => (req, res) => setTimeout(() => res.json(method(req)), process.env.LATENCY || 0);
const stats = {resources: [{index: 0, state: 'RUNNING'}]};
const validateParentGuid = ({params: {parentType, parentGuid}}, res, next) => next(!state[parentType][parentGuid] && 'router');
const validateParentType = ({params: {parentType}}, res, next) => next(!state[parentType] && 'router');
const validateGuid = ({params: {type, guid}}, res, next) => next(!state[type][guid] && 'router');
const validateType = ({params: {type}}, res, next) => next(!state[type] && 'router');

express()
  .get('/v2/config/feature_flags/:name', send(({params: {name}}) => featureFlag(name)))
  .get('/v3/apps/:appGuid/processes/:processGuid/stats', send(() => stats))
  .get('/v2/organizations/:orgGuid/memory_usage', send(() => memoryUsage))
  .get('/v2/:type/', validateType, send(Capi.v2.page))
  .get('/v2/:type/:guid', validateType, validateGuid, send(Capi.v2.resource))
  .get('/v2/:parentType/:parentGuid/:type', validateParentType, validateParentGuid, validateType, send(Capi.v2.page))
  .get('/v3/:type/', validateType, send(Capi.v3.page))
  .get('/v3/:type/:guid', validateType, validateGuid, send(Capi.v3.resource))
  .listen(process.env.PORT || 8000);