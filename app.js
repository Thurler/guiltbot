const fs = require('fs');
const request = require('request-promise');
const config = require('./config.json');

const Discord = require('discord.js');
const client = new Discord.Client();

const pollStreamInterval = 2*60*1000;    // Poll streams every 2 minutes
const renewStreamInterval = 60*60*1000;  // Update if >1 hour between streams

let twitchApiToken = null;

const logSomething = function(text) {
  console.log(new Date().toISOString() + ' | ' + text);
};

const updateToken = async function() {
  let url = 'https://id.twitch.tv/oauth2/token?';
  url += 'client_id='+config.twitch.clientId+'&';
  url += 'client_secret='+config.twitch.clientSecret+'&';
  url += 'grant_type=client_credentials';
  let body = await request.post({url: url});
  body = JSON.parse(body);
  if (body.hasOwnProperty('access_token')) {
    twitchApiToken = body.access_token;
  }
};

const checkIsNewStream = function(streamid, userid) {
  let data = JSON.parse(fs.readFileSync('./database.json'));
  if (!(userid in data)) return true;
  if (data[userid].id === streamid) return false;
  return (Date.now() - data[userid].date > renewStreamInterval);
};

const updateNewStream = function(streamid, userid) {
  let data = JSON.parse(fs.readFileSync('./database.json'));
  data[userid] = {
    date: Date.now(),
    id: streamid,
  };
  fs.writeFileSync('./database.json', JSON.stringify(data));
};

const getAvatarFromUserId = async function(userid) {
  let url = 'https://api.twitch.tv/helix/users?id=' + userid;
  let header = {
    'Client-ID': config.twitch.clientId,
    'Authorization': 'Bearer ' + twitchApiToken,
  };
  try {
    let body = await request.get({
      url: url,
      headers: header,
    });
    body = JSON.parse(body);
    return body.data[0].profile_image_url;
  } catch (err) {
    logSomething(err);
    return null;
  }
};

const checkSpeedrunTag = async function(userid) {
  let url = 'https://api.twitch.tv/helix/channels?broadcaster_id=' + userid;
  let header = {
    'Client-ID': config.twitch.clientId,
    'Authorization': 'Bearer ' + twitchApiToken,
  };
  try {
    let body = await request.get({
      url: url,
      headers: header,
    });
    body = JSON.parse(body);
    return body.data[0].tags.some((tag) => tag.match(/speedrun/i));
  } catch (err) {
    logSomething(err);
    return false;
  }
};

const buildStreamsReply = async function(streams) {
  let twitchIconUrl = 'https://raw.githubusercontent.com/Thurler/guiltbot/master/twitch.png';
  let messages = [];
  for (const stream of streams) {
    let user = stream.user_name;
    let streamName = stream.user_login;
    let game = config.twitch.games.find((g)=>g.id===stream.game_id).name;
    let reply = {
      content: `${user} is streaming ${game}!`,
      embed: {
        title: stream.title,
        url: 'https://twitch.tv/' + streamName,
        color: 696969,
        timestamp: Date.now(),
        author: {
          name: user,
          url: 'https://twitch.tv/' + streamName,
          icon_url: twitchIconUrl,
        },
      },
    };
    let icon = await getAvatarFromUserId(stream.user_id);
    if (icon) {
      reply.embed.thumbnail = {url: icon};
    }
    messages.push(reply);
  }
  return messages;
};

const getRelevantStreams = async function(force) {
  let url = 'https://api.twitch.tv/helix/streams';
  let header = {
    'Client-ID': config.twitch.clientId,
    'Authorization': 'Bearer ' + twitchApiToken,
  };
  let params = {'game_id': config.twitch.games.map((game) => game.id)};
  try {
    let body = await request.get({
      url: url,
      headers: header,
      qs: params,
    });
    body = JSON.parse(body);
    let streams = [];
    for (const stream of body.data) {
      // Filter streams from different games
      if (!config.twitch.games.some((g)=>g.id===stream.game_id)) continue;
      // Filter blocked user streams
      if (config.blockedUsers.includes(stream.user_name)) continue;
      // Remove streams that were already posted, unless forced
      if (!force && !checkIsNewStream(stream.id, stream.user_id)) continue;
      // Lastly, check if streamer set "speedrun" as a tag
      if (!(await checkSpeedrunTag(stream.user_id))) continue;
      // Properly update database if we made it this far
      updateNewStream(stream.id, stream.user_id);
      streams.push(stream);
    }
    return {streams: streams};
  } catch (err) {
    if (err['name'] === 'StatusCodeError' && err['statusCode'] === 401) {
      logSomething('Getting a new Twitch API token...');
      await updateToken();
      return getRelevantStreams(force);
    }
    logSomething(err);
    return {streams: null};
  }
};

const checkStreams = async function() {
  logSomething('Looking for new streams...');
  let channel = client.channels.array().find((c)=>c.id == config.channel);
  let result = await getRelevantStreams(false);
  let streams = result.streams;
  if (!streams || streams.length === 0) {
    logSomething('No streams found.');
    return;
  }
  logSomething('Found ' + streams.length.toString() + ' new streams.');
  let messages = await buildStreamsReply(streams);
  messages.forEach((msg)=>{
    channel.send(msg.content, {'embed': msg.embed});
  });
};

client.on('ready', ()=>{
  client.user.setActivity(config.discordActivity);
  checkStreams();
});

client.on('message', async (message)=>{
  if (message.author.bot) return; // Ignore other bots
  if (message.content.indexOf('!') !== 0) return; // Ignore no prefix

  // Post only in #streams channel
  if (message.channel.id !== config.channel) return;

  const args = message.content.slice(config.prefix.length).trim().split(/ !/g);
  const command = args.shift().toLowerCase();

  if (command === 'live') {
    // Display live streams
    logSomething('Live command received...');
    let result = await getRelevantStreams(true);
    let streams = result.streams;
    if (streams === null) {
      return message.channel.send('Error finding streams');
    } else if (streams.length === 0) {
      return message.channel.send('No relevant streams found');
    }
    let messages = await buildStreamsReply(streams);
    messages.forEach((msg)=>{
      message.channel.send(msg.content, {'embed': msg.embed});
    });
  }
});

if (!fs.existsSync('./database.json')) {
  logSomething('Creating database file...');
  fs.writeFileSync('./database.json', '{}');
}

client.login(config.token);
setInterval(checkStreams, pollStreamInterval);
