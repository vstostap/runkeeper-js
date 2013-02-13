var HealthGraph = require('../'),
    express = require('express'),
    options = require('./options'),
    app = express();

var runkeeper = new HealthGraph(options);

app.get('/', function(req, res) {
  runkeeper.getAuthCode(res);
});

app.get('/callback', function(req, res) {
  var code = req.query.code;
  
  runkeeper.getNewToken(code, function(err, access_token) {
    if (err) return res.send(err);

    runkeeper.access_token = access_token;

    res.send('Wooo! Now go to <a href="/activityFeed">/activityFeed</a> to get all the activities for the user.');
  });
});

app.get('/activityFeed', function(req, res) {
  var opts = {
    get_next: true
  };

  runkeeper.activityFeed(opts, function(err, data) {
    if (err) return res.send(err);

    res.send(data);
  });
});

app.get('/profile', function(req, res) {
  var opts = { resource: 'profile' };

  runkeeper.apiCall(opts, function(err, data) {
    if (err) return res.send(err);

    res.send(data);
  });
});

app.listen(3000);
console.log('Listening at http://localhost:3000/');