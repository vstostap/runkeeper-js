/*
* Current Health Graph API rate limits
* 100,000 total calls per day for an app
* 5 calls per minute per user
*/

var separateReqPool = { maxSockets: 100 },
    rates = { rate: 5, window: 60000 }, // 5 per minute
    backOffTime = 30000, // half a minute
    defaultBackOffLimit = 10; // allowed count of backoffs for the very same call

var request = require('request'),
    _ = require('underscore'),
    querystring = require('querystring'),
    throttle = require("tokenthrottle")(rates);

// Predefined API Routes
var resources = {
  user: {
    media_type: 'application/vnd.com.runkeeper.User+json',
    uri: '/user'
  },
  profile: {
    media_type: 'application/vnd.com.runkeeper.Profile+json',
    uri: '/profile'
  },
  settings: {
    media_type: 'application/vnd.com.runkeeper.Settings+json',
    uri: '/settings'
  },
  fitnessActivityFeed: {
    media_type: 'application/vnd.com.runkeeper.FitnessActivityFeed+json',
    uri: '/fitnessActivities'
  },
  fitnessActivities: {
    media_type: 'application/vnd.com.runkeeper.FitnessActivity+json',
    uri: '/fitnessActivities'
  }
};

var HealthGraph = module.exports = function(options) {
  this.client_id = options.client_id || null ;
  this.client_secret = options.client_secret || null;
  this.auth_url = options.auth_url || 'https://runkeeper.com/apps/authorize';
  this.access_token_url = options.access_token_url || 'https://runkeeper.com/apps/token';
  this.redirect_uri = options.redirect_uri || null;
  this.access_token = options.access_token || null;
  this.api_domain = options.api_domain || 'https://api.runkeeper.com';
};

HealthGraph.prototype.getAuthCode = function(res) {
  if (!this.access_token) {
    var query = { client_id: this.client_id, response_type: 'code' };

    if (this.redirect_uri) query.redirect_uri = this.redirect_uri;

    return res.redirect(this.auth_url + '?' + querystring.stringify(query));
  } else {
    return this.access_token;
  }
};

// Runkeeper OAuth docs: http://developer.runkeeper.com/healthgraph/registration-authorization
// getToken performs Step 2
HealthGraph.prototype.getNewToken = function (authorization_code, callback) {
  var request_params, request_details;

  if (!authorization_code)
    return callback(new TypeError('authorization_code is required'), null);

  request_params = {
    grant_type: 'authorization_code',
    code: authorization_code,
    client_id: this.client_id,
    client_secret: this.client_secret,
    redirect_uri: this.redirect_uri
  };

  request_details = {
    method: 'POST',
    headers: {'content-type' : 'application/x-www-form-urlencoded'},
    uri: this.access_token_url,
    body: querystring.stringify(request_params),
    pool: separateReqPool
  };

  request(request_details, function(error, response, body) {
    callback(error, JSON.parse(body)['access_token']);
  });
};

/**
 * Used to make generic and internal calls to the API.
 *
 * The opts object requires that either opts.resource or opts.media_type and opts.uri to be set.
 *
 * TODO: More info about the opts object.
 *
 * @param opts     {Object}   opts     See above for required params.
 * @param callback {Function} callback Given err and result.
 */
HealthGraph.prototype.apiCall = function(opts, callback) {
  var self = this;

  self.backOffUsed = this.backOffUsed || 0;

  var backOffLimit = opts.backOffLimit || defaultBackOffLimit;
  var backOffAllowed = self.backOffUsed >= backOffLimit ? false : true;

  var request_details, parsed, params = '',
      access_token = opts.access_token || this.access_token;

  var backoff = function() {
     self.backOffUsed = self.backOffUsed + 1;
     return setTimeout(self.apiCall.bind(self, opts, callback), backOffTime);
  };

  //defaultBackOffsLimit

  if (opts.resource)
    _.extend(opts, resources[opts.resource]);

  if (opts.params) {
    params = '?' + (typeof opts.params === 'object' ?
      querystring.stringify(opts.params) : opts.params);
  }

  request_details = {
    method: opts.method || 'GET',
    headers: {
      'Accept': opts.media_type,
      'Authorization' : 'Bearer ' + access_token
    },
    uri: this.api_domain + opts.uri + params,
    pool: separateReqPool
  };

  if (opts.timeout) {
    request_details.timeout = opts.timeout;
  }

  if (opts.modified_since) {
    if (!(opts.modified_since instanceof Date))
      return callback(new Error('modified_since has to be a instance of Date'), null);

    request_details.headers['If-Modified-Since'] = opts.modified_since.toUTCString();
  }

  throttle.rateLimit(access_token, function (err, limited) {
    if (err) return callback(new Error('RunKeeper limit by user error.'), null);

    // backOff timeout
    if (limited && backOffAllowed) {
        return backoff();
    }

    request(request_details, function(err, res, body) {
      if (err) {
          if (JSON.stringify(err).match(/Rate-limit/)) {
              if (backOffAllowed) return backoff();
          }
          return callback(err, null);
      }

      if (res.statusCode !== 200 && res.statusCode !== 304) {
        if (JSON.stringify(body).match(/Rate-limit/) || res.statusCode === 429) {
            if (backOffAllowed) return backoff();
        }
        var error = new Error('Runkeeper returned status code ' + res.statusCode);
        error.statusMessage = body;
        return callback(error, null);
      }

      if (!body)
        return callback(null, {});

      try {
        parsed = JSON.parse(body);
      } catch(e) {
        return callback(new Error('RunKeeper body reply is not a valid JSON string.'), null);
      }

      callback(null, parsed);
    });
  });
};

/**
 * Get the activity feed for the authenticated user.
 *
 * If passed opts.get_next it will get all items of the activity feed until there is no more
 * `data.next`.
 *
 * If passed opts.modified_since you might get an empty response (304 Not Modified). In those cases callback(null, []) will be called
 *
 * @param {Object}   opts     (Optional) Gets extended by `resources.fitnessActivityFeed`.
 * @param {Function} callback Given err and data.
 */
HealthGraph.prototype.activityFeed = function(opts, callback) {
  var self = this;

  if (typeof opts === 'function') {
    callback = opts;
    opts = {};
  }

  _.extend(opts, resources.fitnessActivityFeed);

  if (opts.get_next) {
    if (!opts.items) opts.items = [];

    this.apiCall(opts, function(err, data) {
      if (err) return callback(err, null);
      if (!data.items) return callback(null, []);

      if (data.next) {
        opts.items = data.items.concat(opts.items);
        opts.params = data.next.replace(/.+\?/, '');

        self.activityFeed(opts, callback);
      } else {
        opts.items = data.items.concat(opts.items);

        callback(null, {
          items: opts.items,
          size: opts.items.length
        });
      }
    });
  } else {
    this.apiCall(opts, callback);
  }
};
