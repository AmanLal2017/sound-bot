const { Client, GatewayIntentBits, EmbedBuilder, SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, PermissionsBitField, ApplicationCommandOptionType } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus } = require('@discordjs/voice');
const play = require('play-dl');
const { REST } = require('@discordjs/rest');
const { Routes } = require('discord-api-types/v10');
const axios = require('axios');
require('dotenv').config();

play.setToken({
  soundcloud: {
    client_id: process.env.SOUNDCLOUD_CLIENT_ID || "X0XUYgYuJk5p3BEb5NCV8t3MiGpfbRhz"
  }
});

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent,
  ],
});

const queue = new Map();
const searchResults = new Map();

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

client.once('ready', async () => {
  console.log(`Bot is online as ${client.user.tag}`);
  
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  
  try {
    await rest.put(
      Routes.applicationCommands(client.user.id),
      { body: commands },
    );
    console.log('Slash commands registered globally');
  } catch (error) {
    console.error('Error registering slash commands:', error);
  }
});

async function playSong(guild, song) {
  const serverQueue = queue.get(guild.id);
  
  if (!song) {
    serverQueue.connection.destroy();
    queue.delete(guild.id);
    return;
  }
  
  try {
    const source = await play.stream(song.url);
    
    const resource = createAudioResource(source.stream, {
      inputType: source.type,
    });
    
    const player = createAudioPlayer();
    serverQueue.connection.subscribe(player);
    
    player.play(resource);
    serverQueue.player = player;
    
    const embed = new EmbedBuilder()
      .setTitle('Soundcloud')
      .setColor('#FF7700')
      .addFields(
        { name: 'Artist', value: song.author, inline: true },
        { name: '🎵 Now Playing', value: `[${song.title}](${song.url})`, inline: true },
        { name: 'Duration', value: formatDuration(song.duration), inline: true }
      );
    
    if (song.thumbnailUrl) {
      embed.setImage(song.thumbnailUrl);
    }
    
    const row = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setLabel('Open in SoundCloud')
          .setURL(song.permalinkUrl)
          .setStyle(ButtonStyle.Link)
      );
    
    await serverQueue.textChannel.send({ 
      embeds: [embed],
      components: [row]
    });
    
    player.on(AudioPlayerStatus.Idle, () => {
      serverQueue.songs.shift();
      playSong(guild, serverQueue.songs[0]);
    });
    
    player.on('error', error => {
      console.error(`Error: ${error.message}`);
      serverQueue.songs.shift();
      playSong(guild, serverQueue.songs[0]);
    });
    
  } catch (error) {
    console.error(`Error playing song: ${error.message}`);
    serverQueue.songs.shift();
    playSong(guild, serverQueue.songs[0]);
  }
}

function formatDuration(seconds) {
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.floor(seconds % 60);
  return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
}

async function addSongToQueue(interaction, songInfo, voiceChannel) {
  let embedInfo = {};
  try {
    const oEmbedResponse = await axios.get('https://soundcloud.com/oembed', {
      params: {
        format: 'json',
        url: songInfo.url
      }
    });
    embedInfo = oEmbedResponse.data;
  } catch (err) {
    console.error('Error fetching oEmbed data:', err);
  }

  const song = {
    title: songInfo.name || songInfo.title,
    url: songInfo.url,
    permalinkUrl: embedInfo.url || songInfo.permalink || songInfo.url,
    duration: songInfo.durationInSec,
    thumbnailUrl: embedInfo.thumbnail_url || '',
    waveformUrl: songInfo.waveform_url || '',
    author: embedInfo.author_name || songInfo.user?.name || 'Unknown artist',
    embedHtml: embedInfo.html || ''
  };
  
  const serverQueue = queue.get(interaction.guild.id);

  if (!serverQueue) {
    const queueConstruct = {
      textChannel: interaction.channel,
      voiceChannel: voiceChannel,
      connection: null,
      songs: [],
      player: null,
      volume: 5,
      playing: true
    };
    
    queue.set(interaction.guild.id, queueConstruct);
    queueConstruct.songs.push(song);
    
    try {
      const connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: interaction.guild.id,
        adapterCreator: interaction.guild.voiceAdapterCreator,
      });
      
      queueConstruct.connection = connection;
      await interaction.editReply(`Added **${song.title}** to the queue!`);
      playSong(interaction.guild, queueConstruct.songs[0]);
    } catch (err) {
      console.error(err);
      queue.delete(interaction.guild.id);
      return interaction.editReply('Error joining voice channel!');
    }
  } else {
    serverQueue.songs.push(song);
    return interaction.editReply(`Added **${song.title}** to the queue!`);
  }
}

client.on('interactionCreate', async interaction => {
  if (interaction.isAutocomplete()) {
    if (interaction.commandName === 'play') {
      const focusedValue = interaction.options.getFocused();
      
      if (focusedValue.length < 2) {
        await interaction.respond([
          { name: 'Type at least 2 characters to search...', value: 'placeholder' }
        ]);
        return;
      }
      
      try {
        if (focusedValue.includes('soundcloud.com')) {
          await interaction.respond([
            { name: `Play SoundCloud URL: ${focusedValue}`, value: focusedValue }
          ]);
          return;
        }
        
        const results = await play.search(focusedValue, { 
          source: { soundcloud: "tracks" }, 
          limit: 15 
        });
        
        if (results.length === 0) {
          await interaction.respond([
            { name: 'No results found', value: 'no_results' }
          ]);
          return;
        }
        
        const options = results.map((track, index) => {
          const artist = track.user?.name || 'Unknown artist';
          const duration = formatDuration(track.durationInSec);
          const name = `${track.name || track.title} - ${artist} - ${duration}`;
          
          return {
            name: name.length > 100 ? name.substring(0, 97) + '...' : name,
            value: `result_${index}`
          };
        });
        
        const userKey = `${interaction.guild.id}_${interaction.user.id}`;
        searchResults.set(userKey, {
          tracks: results,
          query: focusedValue
        });
        
        await interaction.respond(options);
      } catch (error) {
        console.error(`Error in autocomplete: ${error.message}`);
        await interaction.respond([
          { name: 'Error searching SoundCloud', value: 'error' }
        ]);
      }
    }
  }
  
  else if (interaction.isCommand()) {
    const { commandName } = interaction;
    const serverQueue = queue.get(interaction.guild.id);
    
    if (commandName === 'play') {
      const query = interaction.options.getString('query');
      const voiceChannel = interaction.member.voice.channel;
      
      if (!voiceChannel) {
        return interaction.reply('You need to be in a voice channel to play music!');
      }
      
      const permissions = voiceChannel.permissionsFor(interaction.client.user);
      if (!permissions.has(PermissionsBitField.Flags.Connect) || !permissions.has(PermissionsBitField.Flags.Speak)) {
        return interaction.reply('I need permissions to join and speak in your voice channel!');
      }
      
      try {
        await interaction.deferReply();
        
        if (query.includes('soundcloud.com')) {
          const songInfo = await play.soundcloud(query);
          await addSongToQueue(interaction, songInfo, voiceChannel);
        } 

        else if (query.startsWith('result_')) {
          const userKey = `${interaction.guild.id}_${interaction.user.id}`;
          const searchData = searchResults.get(userKey);
          
          if (!searchData) {
            return interaction.editReply('Search results expired. Please try again.');
          }
          
          const trackIndex = parseInt(query.replace('result_', ''));
          const selectedTrack = searchData.tracks[trackIndex];
          
          if (!selectedTrack) {
            return interaction.editReply('Selected track not found. Please try again.');
          }
          
          await addSongToQueue(interaction, selectedTrack, voiceChannel);
          searchResults.delete(userKey);
        }

        else {
          const searchedTracks = await play.search(query, { 
            source: { soundcloud: "tracks" }, 
            limit: 1
          });
          
          if (searchedTracks.length === 0) {
            return interaction.editReply('No songs found!');
          }
          
          await addSongToQueue(interaction, searchedTracks[0], voiceChannel);
        }
      } catch (error) {
        console.error(`Error in play command: ${error.message}`);
        return interaction.editReply('An error occurred while trying to play the song.');
      }
    }
    
    else if (commandName === 'skip') {
      if (!serverQueue) {
        return interaction.reply('There is no song to skip!');
      }
      
      if (!interaction.member.voice.channel) {
        return interaction.reply('You need to be in a voice channel to skip songs!');
      }
      
      serverQueue.player.stop();
      return interaction.reply('⏭️ Skipped the song!');
    }
    
    else if (commandName === 'stop') {
      if (!serverQueue) {
        return interaction.reply('There is nothing playing!');
      }
      
      if (!interaction.member.voice.channel) {
        return interaction.reply('You need to be in a voice channel to stop the music!');
      }
      
      serverQueue.songs = [];
      serverQueue.player.stop();
      return interaction.reply('🛑 Stopped the music and cleared the queue!');
    }
    
    else if (commandName === 'queue') {
      if (!serverQueue || serverQueue.songs.length === 0) {
        return interaction.reply('There are no songs in the queue!');
      }
      
      const embed = new EmbedBuilder()
        .setTitle('🎵 Song Queue')
        .setColor('#FF7700')
        .setTimestamp();
      
      const songList = serverQueue.songs.map((song, index) => {
        return `${index + 1}. [${song.title}](${song.url})`;
      }).join('\n');
      
      embed.setDescription(songList.length > 2048 ? songList.substring(0, 2045) + '...' : songList);
      
      return interaction.reply({ embeds: [embed] });
    }
    
    else if (commandName === 'pause') {
      if (!serverQueue || !serverQueue.playing) {
        return interaction.reply('There is nothing playing!');
      }
      
      if (!interaction.member.voice.channel) {
        return interaction.reply('You need to be in a voice channel to pause the music!');
      }
      
      serverQueue.player.pause();
      serverQueue.playing = false;
      return interaction.reply('⏸️ Paused the music!');
    }
    
    else if (commandName === 'resume') {
      if (!serverQueue || serverQueue.playing) {
        return interaction.reply('The music is already playing!');
      }
      
      if (!interaction.member.voice.channel) {
        return interaction.reply('You need to be in a voice channel to resume the music!');
      }
      
      serverQueue.player.unpause();
      serverQueue.playing = true;
      return interaction.reply('▶️ Resumed the music!');
    }
    
    else if (commandName === 'leave') {
      if (!serverQueue) {
        return interaction.reply('I am not in a voice channel!');
      }
      
      if (!interaction.member.voice.channel) {
        return interaction.reply('You need to be in a voice channel to disconnect the bot!');
      }
      
      serverQueue.songs = [];
      serverQueue.connection.destroy();
      queue.delete(interaction.guild.id);
      return interaction.reply('👋 Disconnected from the voice channel!');
    }
  }
  
  else if (interaction.isStringSelectMenu()) {
    if (interaction.customId === 'select_track') {
      const selectedValue = interaction.values[0];
      const guildSearchResults = searchResults.get(interaction.guild.id);
      
      if (!guildSearchResults) {
        return interaction.reply({ 
          content: 'Search results expired. Please run the search again.',
          ephemeral: true 
        });
      }
      
      const selectedTrack = guildSearchResults.tracks[parseInt(selectedValue)];
      const voiceChannel = guildSearchResults.voiceChannel;
      const originalInteraction = guildSearchResults.interaction;
      
      await originalInteraction.editReply({
        content: `Selected: **${selectedTrack.name || selectedTrack.title}**`,
        embeds: [],
        components: []
      });
      
      await interaction.deferReply({ ephemeral: true });
      try {
        await addSongToQueue(interaction, selectedTrack, voiceChannel);
        searchResults.delete(interaction.guild.id);
      } catch (error) {
        console.error(`Error playing selected track: ${error.message}`);
        await interaction.editReply('An error occurred while trying to play the selected track.');
      }
    }
  }
});

client.login(process.env.DISCORD_TOKEN);