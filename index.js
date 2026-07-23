const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionsBitField,
} = require('discord.js');
const { DisTube } = require('distube');
const { SoundCloudPlugin } = require('@distube/soundcloud');
const { REST } = require('@discordjs/rest');
const { getVoiceConnection } = require('@discordjs/voice');
const { Routes } = require('discord-api-types/v10');
require('dotenv').config();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent,
  ],
});

const distube = new DisTube(client, {
  plugins: [
    new SoundCloudPlugin({
      clientId: process.env.SOUNDCLOUD_CLIENT_ID,
    }),
  ],
  emitNewSongOnly: true,
  ffmpeg: {
    path: 'ffmpeg',
    args: {
      input: {
        protocol_whitelist: 'file,http,https,tcp,tls,crypto',
      },
    },
  },
});

const searchResults = new Map();
const lastAutocompleteRequest = new Map();
const respondedInteractions = new Set();

const commands = [
  new SlashCommandBuilder()
    .setName('play')
    .setDescription('Play a song from SoundCloud')
    .addStringOption(option =>
      option.setName('query')
        .setDescription('The song name or URL')
        .setRequired(true)
        .setAutocomplete(true)),
  new SlashCommandBuilder()
    .setName('skip')
    .setDescription('Skip the current song'),
  new SlashCommandBuilder()
    .setName('stop')
    .setDescription('Stop playing and clear the queue'),
  new SlashCommandBuilder()
    .setName('queue')
    .setDescription('Display the current song queue'),
  new SlashCommandBuilder()
    .setName('pause')
    .setDescription('Pause the current song'),
  new SlashCommandBuilder()
    .setName('resume')
    .setDescription('Resume the current song'),
  new SlashCommandBuilder()
    .setName('leave')
    .setDescription('Disconnect bot from voice channel'),
].map(command => command.toJSON());

client.once('clientReady', async () => {
  console.log("Soundcloud Bot is now online.");
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

  try {
    await rest.put(
      Routes.applicationCommands(client.user.id),
      { body: commands },
    );
  } catch (error) {
    console.error('Error registering slash commands:', error);
  }
});

function formatDuration(seconds) {
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.floor(seconds % 60);
  return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
}

async function ensureVoiceChannel(interaction, actionText) {
  if (!interaction.member.voice.channel) {
    await interaction.reply(`You need to be in a voice channel to ${actionText}!`);
    return false;
  }
  return true;
}

distube.on('playSong', (queue, song) => {
  const embed = new EmbedBuilder()
    .setTitle('SoundCloud')
    .setColor('#FF7700')
    .addFields(
      { name: 'Artist', value: song.uploader?.name || 'Unknown artist', inline: true },
      { name: '🎵 Now Playing', value: `[${song.name}](${song.url})`, inline: true },
      { name: 'Duration', value: song.formattedDuration || formatDuration(song.duration), inline: true },
    );

  if (song.thumbnail) {
    embed.setImage(song.thumbnail.replace(/-large|-small|-badge|-tiny/g, '-t500x500'));
  }

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setLabel('Open in SoundCloud')
      .setURL(song.url)
      .setStyle(ButtonStyle.Link),
  );

  queue.textChannel?.send({ embeds: [embed], components: [row] });
});

distube.on('addSong', (queue, song) => {
  if (queue.songs.length > 1) {
    queue.textChannel?.send(`Added **${song.name}** to the queue!`);
  }
});

const pendingRecovery = new Map();

distube.on('error', (...args) => {
  const error = args.find(a => a instanceof Error);
  const queue = args.find(a => a && typeof a === 'object' && Array.isArray(a.songs) && a.textChannel !== undefined);
  const song = args.find(a => a && typeof a === 'object' && typeof a.name === 'string' && typeof a.url === 'string' && !Array.isArray(a.songs));

  console.error('DisTube error:', error?.message || error, song ? `| Song: ${song.name}` : '');

  const channel = queue?.textChannel;
  if (channel) {
    const songName = song?.name ? `**${song.name}**` : 'This track';
    channel.send(`⚠️ ${songName} could not be played (likely a corrupted or encrypted stream) and was skipped.`).catch(() => {});
  }

  if (queue) {
    const remaining = queue.songs.filter(s => s !== song);
    if (remaining.length > 0 && queue.voice?.channel) {
      pendingRecovery.set(queue.id, {
        songs: remaining,
        voiceChannel: queue.voice.channel,
        textChannel: queue.textChannel,
      });
    }
  }
});

distube.on('finish', queue => {
  const recovery = pendingRecovery.get(queue.id);
  pendingRecovery.delete(queue.id);

  if (recovery) {
    try { queue.voice?.leave(); } catch (_) {}

    setTimeout(async () => {
      try {
        for (const s of recovery.songs) {
          await distube.play(recovery.voiceChannel, s, { textChannel: recovery.textChannel });
        }
      } catch (err) {
        console.error('Failed to resume queue after error recovery:', err);
      }
    }, 1500);

    return;
  }

  queue.textChannel?.send('Queue finished, leaving the voice channel.').catch(() => {});
  try { queue.voice?.leave(); } catch (_) {}
});

distube.on('disconnect', queue => {});

// distube.on('debug', message => console.log('[distube debug]', message));
// distube.on('ffmpegDebug', message => console.log('[ffmpeg debug]', message));

client.on('interactionCreate', async interaction => {
 try {
  if (interaction.isAutocomplete()) {
    if (interaction.commandName === 'play') {
      const focusedValue = interaction.options.getFocused();

      const userKey = `${interaction.guild.id}_${interaction.user.id}`;
      const requestId = Symbol();
      lastAutocompleteRequest.set(userKey, requestId);

      const safeRespond = async choices => {
        if (lastAutocompleteRequest.get(userKey) !== requestId) return;
        if (respondedInteractions.has(interaction.id)) return;
        respondedInteractions.add(interaction.id);
        setTimeout(() => respondedInteractions.delete(interaction.id), 10_000);
        try {
          await interaction.respond(choices);
        } catch (err) {
          if (err.code !== 10062 && err.code !== 40060) console.error('Autocomplete respond error:', err);
        }
      };

      if (focusedValue.length < 2) {
        await safeRespond([
          { name: 'Type at least 2 characters to search...', value: 'placeholder' },
        ]);
        return;
      }

      if (focusedValue.includes('soundcloud.com')) {
        await safeRespond([
          { name: `Play SoundCloud URL: ${focusedValue}`, value: focusedValue },
        ]);
        return;
      }

      try {
        const scPlugin = distube.plugins.find(p => p.constructor.name === 'SoundCloudPlugin');

        const results = await Promise.race([
          scPlugin.search(focusedValue, 'track', 15),
          new Promise((_, reject) => setTimeout(() => reject(new Error('search_timeout')), 2200)),
        ]);

        if (lastAutocompleteRequest.get(userKey) !== requestId) return;

        if (!results || results.length === 0) {
          await safeRespond([{ name: 'No results found', value: 'no_results' }]);
          return;
        }

        const options = results.map((track, index) => {
          const artist = track.uploader?.name || 'Unknown artist';
          const duration = formatDuration(track.duration);
          const name = `${track.name} - ${artist} - ${duration}`;

          return {
            name: name.length > 100 ? name.substring(0, 97) + '...' : name,
            value: `result_${index}`,
          };
        });

        searchResults.set(userKey, { tracks: results, query: focusedValue });

        await safeRespond(options);
      } catch (error) {
        console.error(`Error in autocomplete: ${error.message}`);
        await safeRespond([{ name: 'Error searching SoundCloud', value: 'error' }]);
      }
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;
  const queue = distube.getQueue(interaction.guildId);

  if (commandName === 'play') {
    const query = interaction.options.getString('query');

    try {
      await interaction.deferReply();
    } catch (err) {
      if (err.code === 10062) return;
      console.error('Unexpected error deferring reply:', err);
      return;
    }

    const voiceChannel = interaction.member.voice.channel;

    if (!voiceChannel) {
      return interaction.editReply('You need to be in a voice channel to play music!');
    }

    const permissions = voiceChannel.permissionsFor(interaction.client.user);
    if (!permissions.has(PermissionsBitField.Flags.Connect) || !permissions.has(PermissionsBitField.Flags.Speak)) {
      return interaction.editReply('I need permissions to join and speak in your voice channel!');
    }

    try {
      let playQuery = query;

      if (query.startsWith('result_')) {
        const userKey = `${interaction.guild.id}_${interaction.user.id}`;
        const searchData = searchResults.get(userKey);

        if (!searchData) {
          return interaction.editReply('Search results expired. Please try again.');
        }

        const trackIndex = parseInt(query.replace('result_', ''), 10);
        const selectedTrack = searchData.tracks[trackIndex];

        if (!selectedTrack) {
          return interaction.editReply('Selected track not found. Please try again.');
        }

        playQuery = selectedTrack;
        searchResults.delete(userKey);
      }

      await Promise.race([
        distube.play(voiceChannel, playQuery, {
          textChannel: interaction.channel,
          member: interaction.member,
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('play_timeout')), 35_000)),
      ]);

      await interaction.editReply('Got it! 🎶');
    } catch (error) {
      console.error(`Error in play command: ${error.message}`);
      if (error.message === 'play_timeout') {
        return interaction.editReply('SoundCloud took too long to respond — it may be having issues right now. Try again in a moment.');
      }
      if (error.message && error.message.toLowerCase().includes('cannot find any song with this query')) {
        return interaction.editReply(`❌ No results found for **${query}**. Try a different search term or paste a direct SoundCloud URL.`);
      }
      return interaction.editReply('An error occurred while trying to play the song.');
    }
    return;
  }

  if (commandName === 'skip') {
    if (!queue) return interaction.reply('There is no song to skip!');
    if (!(await ensureVoiceChannel(interaction, 'skip songs'))) return;

    try {
      await queue.skip();
      return interaction.reply('⏭️ Skipped the song!');
    } catch (err) {
      return interaction.reply('There is nothing left to skip to.');
    }
  }

  if (commandName === 'stop') {
    if (!queue) return interaction.reply('There is nothing playing!');
    if (!(await ensureVoiceChannel(interaction, 'stop the music'))) return;

    try { queue.voice?.leave(); } catch (_) {}
    queue.stop();
    return interaction.reply('🛑 Stopped the music and cleared the queue!');
  }

  if (commandName === 'queue') {
    if (!queue || queue.songs.length === 0) return interaction.reply('There are no songs in the queue!');

    const embed = new EmbedBuilder().setTitle('🎵 Song Queue').setColor('#FF7700').setTimestamp();

    const songList = queue.songs
      .map((song, index) => `${index + 1}. [${song.name}](${song.url})`)
      .join('\n');

    embed.setDescription(songList.length > 2048 ? songList.substring(0, 2045) + '...' : songList);

    return interaction.reply({ embeds: [embed] });
  }

  if (commandName === 'pause') {
    if (!queue || queue.paused) return interaction.reply('There is nothing playing!');
    if (!(await ensureVoiceChannel(interaction, 'pause the music'))) return;

    queue.pause();
    return interaction.reply('⏸️ Paused the music!');
  }

  if (commandName === 'resume') {
    if (!queue || !queue.paused) return interaction.reply('The music is already playing!');
    if (!(await ensureVoiceChannel(interaction, 'resume the music'))) return;

    queue.resume();
    return interaction.reply('▶️ Resumed the music!');
  }

  if (commandName === 'leave') {
    const connection = getVoiceConnection(interaction.guildId);

    if (!connection && !queue) {
      return interaction.reply('I am not in a voice channel!');
    }
    if (!(await ensureVoiceChannel(interaction, 'disconnect the bot'))) return;

    if (queue) {
      try { queue.voice?.leave(); } catch (_) {}
      queue.stop();
    } else if (connection) {
      connection.destroy();
    }

    return interaction.reply('👋 Disconnected from the voice channel!');
  }
 } catch (err) {
  if (err.code === 10062 || err.code === 40060) {
  } else {
    console.error('Unhandled error in interactionCreate:', err);
  }
 }
});

client.on('error', err => {
  console.error('Discord client error:', err);
});

process.on('unhandledRejection', err => {
  console.error('Unhandled promise rejection:', err);
});

client.login(process.env.DISCORD_TOKEN);