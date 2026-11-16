const fs = require('fs');
const config = require('./config.json');

const {
  Client, GatewayIntentBits, EmbedBuilder, Events,
} = require('discord.js');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const pollStreamInterval = 2 * 60 * 1000;   // Poll streams every 2 minutes
const renewStreamInterval = 60 * 60 * 1000; // Update if >1 hour between streams

let twitchApiToken = null;

const logSomething = function(text) {
  console.log(new Date().toISOString() + ' | ' + text);
};

const updateToken = async function() {
  try {
    const url = new URL('https://id.twitch.tv/oauth2/token');
    url.searchParams.append('client_id', config.twitch.clientId);
    url.searchParams.append('client_secret', config.twitch.clientSecret);
    url.searchParams.append('grant_type', 'client_credentials');
    const res = await fetch(url, { method: 'POST' });
    const body = await res.json();
    if (body.access_token) {
      twitchApiToken = body.access_token;
    }
  } catch (err) {
    logSomething('Failed to update Twitch token: ' + err);
  }
};

const checkIsNewStream = function(streamid, userid) {
  const data = JSON.parse(fs.readFileSync('./database.json'));
  if (!(userid in data)) return true;
  if (data[userid].id === streamid) return false;
  return (Date.now() - data[userid].date > renewStreamInterval);
};

const updateNewStream = function(streamid, userid) {
  const data = JSON.parse(fs.readFileSync('./database.json'));
  data[userid] = {
    date: Date.now(),
    id: streamid,
  };
  fs.writeFileSync('./database.json', JSON.stringify(data));
};

const getAvatarFromUserId = async function(userid) {
  const url = `https://api.twitch.tv/helix/users?id=${userid}`;
  const headers = {
    'Client-ID': config.twitch.clientId,
    'Authorization': `Bearer ${twitchApiToken}`,
  };
  try {
    const res = await fetch(url, { headers });
    const body = await res.json();
    return body.data?.[0]?.profile_image_url || null;
  } catch (err) {
    logSomething(err);
    return null;
  }
};

const checkSpeedrunTag = async function(userid) {
  const url = `https://api.twitch.tv/helix/channels?broadcaster_id=${userid}`;
  const headers = {
    'Client-ID': config.twitch.clientId,
    'Authorization': `Bearer ${twitchApiToken}`,
  };
  try {
    const res = await fetch(url, { headers });
    const body = await res.json();
    return body.data?.[0]?.tags?.some(
      (tag) => tag.toLowerCase() === 'speedrun',
    ) ?? false;
  } catch (err) {
    logSomething(err);
    return false;
  }
};

const buildStreamsReply = async function(streams) {
  const twitchIconUrl =
      'https://raw.githubusercontent.com/Thurler/guiltbot/master/twitch.png';
  const messages = [];
  for (const stream of streams) {
    const user = stream.user_name;
    const streamName = stream.user_login;
    const game = config.twitch.games.find((g)=>g.id===stream.game_id).name;
    const embed = new EmbedBuilder()
      .setTitle(stream.title)
      .setURL(`https://twitch.tv/${streamName}`)
      .setColor(0x696969)
      .setTimestamp()
      .setAuthor({
        name: user,
        url: `https://twitch.tv/${streamName}`,
        iconURL: twitchIconUrl,
      });
    const icon = await getAvatarFromUserId(stream.user_id);
    if (icon) {
      embed.setThumbnail(icon);
    }
    messages.push({
      content: `${user} is streaming ${game}!`,
      embeds: [embed],
    });
  }
  return messages;
};

const getRelevantStreams = async function(force) {
  if (!twitchApiToken) {
    await updateToken();
  }
  const url = new URL('https://api.twitch.tv/helix/streams');
  config.twitch.games.forEach(
    (game) => url.searchParams.append('game_id', game.id),
  );

  const headers = {
    'Client-ID': config.twitch.clientId,
    'Authorization': `Bearer ${twitchApiToken}`,
  };
  try {
    const res = await fetch(url, { headers });

    if (res.status === 401) {
      logSomething('Getting a new Twitch API token...');
      await updateToken();
      return getRelevantStreams(force);
    }

    const body = await res.json();
    const streams = [];

    for (const stream of body.data || []) {
      // Filter streams from different games
      if (!config.twitch.games.some((g) => g.id === stream.game_id)) continue;
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
    return { streams };
  } catch (err) {
    logSomething(err);
    return { streams: null };
  }
};

const checkStreams = async function() {
  logSomething('Looking for new streams...');
  const channel = client.channels.cache.get(config.channel);
  if (!channel) {
    logSomething('Configured channel not found in cache.');
    return;
  }
  const result = await getRelevantStreams(false);
  const streams = result.streams;
  if (!streams || streams.length === 0) {
    logSomething('No streams found.');
    return;
  }
  logSomething(`Found ${streams.length} new streams.`);
  const messages = await buildStreamsReply(streams);
  for (const msg of messages) {
    await channel.send(msg);
  }
};

client.once(Events.ClientReady, () => {
  logSomething(`Logged in as ${client.user.tag}`);
  if (config.discordActivity) {
    client.user.setActivity(config.discordActivity);
  }
  checkStreams();
  setInterval(checkStreams, pollStreamInterval);
});

client.on(Events.MessageCreate, async (message) => {
  // Ignore other bots
  if (message.author.bot) return;
  // Ignore no prefix
  if (!message.content.startsWith(config.prefix || '!')) return;
  // Post only in #streams channel
  if (message.channel.id !== config.channel) return;

  const prefix = config.prefix || '!';
  const args = message.content.slice(prefix.length).trim().split(/\s+/);
  const command = args.shift().toLowerCase();

  if (command === 'live') {
    logSomething('Live command received...');
    const result = await getRelevantStreams(true);
    const streams = result.streams;

    if (streams === null) {
      return message.channel.send('Error finding streams');
    } else if (streams.length === 0) {
      return message.channel.send('No relevant streams found');
    }

    const messages = await buildStreamsReply(streams);
    for (const msg of messages) {
      await message.channel.send(msg);
    }
  }
});

if (!fs.existsSync('./database.json')) {
  logSomething('Creating database file...');
  fs.writeFileSync('./database.json', '{}');
}

client.login(config.token);
