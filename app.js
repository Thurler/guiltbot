const fs = require('fs');
const async = require('asyncawait/async');
const await = require('asyncawait/await');
const request = require('request-promise');
const config = require('./config.json');

const Discord = require('discord.js');
const client = new Discord.Client();

const pollStreamInterval = 5*60*1000;    // Poll streams every 5 minutes
const renewStreamInterval = 60*60*1000;  // Update if >1 hour between streams

let twitchApiToken = null;

logSomething = function(text) {
  console.log(new Date().toISOString() + ' | ' + text);
};

updateToken = async(function() {
  let url = 'https://id.twitch.tv/oauth2/token?';
  url += 'client_id='+config.twitch.clientId+'&';
  url += 'client_secret='+config.twitch.clientSecret+'&';
  url += 'grant_type=client_credentials';
  let body = await(request.post({url: url}));
  body = JSON.parse(body);
  if (body.hasOwnProperty('access_token')) {
    twitchApiToken = body.access_token;
  }
});

getGameNameFromId = function(id) {
  return config.twitch.games.find((g)=>g.id===id).name;
};

checkIsNewStream = function(streamid, userid) {
  let data = JSON.parse(fs.readFileSync('./database.json'));
  if (userid in data) {
    if (data[userid].id === streamid) return false;
    let now = Date.now();
    if (now - data[userid].date > renewStreamInterval) {
      data[userid].date = now;
      data[userid].id = streamid;
      fs.writeFileSync('./database.json', JSON.stringify(data));
      return true;
    }
    return false;
  }
  data[userid] = {
    date: Date.now(),
    id: streamid,
  };
  fs.writeFileSync('./database.json', JSON.stringify(data));
  return true;
};

getAvatarFromUserId = async(function(userid) {
  let url = 'https://api.twitch.tv/kraken/users/' + userid;
  let header = {
    'Client-ID': config.twitch.clientId,
    'Accept': 'application/vnd.twitchtv.v5+json'
  };
  try {
    let body = await(request.get({
      url: url,
      headers: header,
    }));
    body = JSON.parse(body);
    return body.logo;
  } catch (err) {
    console.log(err);
    return null;
  }
});

buildStreamsReply = async(function(streams) {
  let twitchIconUrl = 'https://assets.help.twitch.tv/Glitch_Purple_RGB.png';
  let messages = [];
  messages = streams.map((stream)=>{
    let user = stream.user_name;
    let game = getGameNameFromId(stream.game_id);
    let icon = await(getAvatarFromUserId(stream.user_id));
    let url = 'https://api.twitch.tv/kraken/users/' + stream.user_id;
    let reply = {
      content: user + ' is streaming ' + game + '!',
      embed: {
        title: stream.title,
        url: 'https://twitch.tv/' + user,
        color: 696969,
        timestamp: Date.now(),
        author: {
          name: user,
          url: 'https://twitch.tv/' + user,
          icon_url: twitchIconUrl,
        },
      },
    };
    if (icon) {
      reply.embed.thumbnail = {};
      reply.embed.thumbnail.url = icon;
    }
    return reply;
  });
  return messages;
});

getRelevantStreams = async(function(force) {
  let url = 'https://api.twitch.tv/helix/streams';
  let header = {
    'Client-ID': config.twitch.clientId,
    'Authorization': 'Bearer ' + twitchApiToken,
  };
  let params = { 'game_id': [] };
  config.twitch.games.forEach((game)=>{ params.game_id.push(game.id); });
  try {
    let body = await(request.get({
      url: url,
      headers: header,
      qs: params,
    }));
    body = JSON.parse(body);
    let streams = body.data.filter((stream)=>{
      // Filter non-speedrun streams
      if (!stream.tag_ids.includes(config.twitch.tagId)) return false;
      // Filter non-trauma streams
      if (!config.twitch.games.some((g)=>g.id===stream.game_id)) return false;
      // Remove streams that were already posted, unless forced
      if (force) return true;
      return checkIsNewStream(stream.id, stream.user_id);
    });
    return streams;
  } catch (err) {
    if (!twitchApiToken && err['name'] === 'StatusCodeError' && err['statusCode'] === 401) {
      logSomething('Getting a new token...');
      await(updateToken());
      return getRelevantStreams(force);
    }
    console.log(err);
    return null;
  }
});

checkStreams = async(function() {
  logSomething('Looking for new streams...');
  let channel = client.channels.array().find((c)=>c.id == config.channel);
  let streams = await(getRelevantStreams(false));
  if (!streams || streams.length === 0) {
    console.log('No streams found.');
    return;
  }
  console.log('Found ' + streams.length.toString() + ' new streams.');
  let messages = await(buildStreamsReply(streams));
  messages.forEach((msg)=>{
    channel.send(msg.content, {'embed': msg.embed});
  });
});

client.on('ready', ()=>{
  client.user.setActivity('with GUILT'); // owo
  checkStreams();
});

client.on('message', async((message)=>{
  if (message.author.bot) return; // Ignore other bots
  if (message.content.indexOf('!') !== 0) return; // Ignore no prefix

  // Post only in #streams channel
  if (message.channel.id !== config.channel) return;

  const args = message.content.slice(config.prefix.length).trim().split(/ !/g);
  const command = args.shift().toLowerCase();

  if (command === 'live') {
    // Display live streams
    logSomething('Live command received...');
    let streams = await(getRelevantStreams(true));
    if (streams === null) {
      return message.channel.send('Error finding streams');
    }
    else if (streams.length === 0) {
      return message.channel.send('No relevant streams found');
    }
    let messages = await(buildStreamsReply(streams));
    messages.forEach((msg)=>{
      message.channel.send(msg.content, {'embed': msg.embed});
    });
  }
}));

client.login(config.token);

fs.writeFileSync('./database.json', '{}');
setInterval(checkStreams, pollStreamInterval);
