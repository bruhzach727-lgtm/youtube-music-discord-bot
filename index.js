const {
  Client,
  GatewayIntentBits,
  Events,
  REST,
  Routes,
  SlashCommandBuilder
} = require("discord.js");

const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  NoSubscriberBehavior,
  entersState,
  VoiceConnectionStatus
} = require("@discordjs/voice");

const play = require("play-dl");
const { spawn } = require("child_process");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates
  ]
});

const PLAYLIST_URL =
  "https://music.youtube.com/playlist?list=PLKdNkNcMbulo";

const queues = new Map();

const commands = [
  new SlashCommandBuilder()
    .setName("play")
    .setDescription("Play a SoundCloud track by URL")
    .addStringOption(o =>
      o.setName("url")
        .setDescription("Public SoundCloud track URL")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("playplaylist")
    .setDescription("Show your YouTube Music playlist"),

  new SlashCommandBuilder()
    .setName("skip")
    .setDescription("Skip the current track"),

  new SlashCommandBuilder()
    .setName("pause")
    .setDescription("Pause playback"),

  new SlashCommandBuilder()
    .setName("resume")
    .setDescription("Resume playback"),

  new SlashCommandBuilder()
    .setName("queue")
    .setDescription("Show the music queue"),

  new SlashCommandBuilder()
    .setName("shuffle")
    .setDescription("Shuffle queued tracks"),

  new SlashCommandBuilder()
    .setName("stop")
    .setDescription("Stop playback and leave voice"),

  new SlashCommandBuilder()
    .setName("nowplaying")
    .setDescription("Show the current track"),

  new SlashCommandBuilder()
    .setName("ping")
    .setDescription("Check bot status")
].map(c => c.toJSON());

function getQueue(guildId) {
  return queues.get(guildId);
}

function connectToVoice(interaction, q) {
  const channel = interaction.member.voice?.channel;

  if (!channel) {
    throw new Error("Join a voice channel first.");
  }

  if (q.connection?.state.status !== VoiceConnectionStatus.Destroyed) {
    if (q.connection) return q.connection;
  }

  q.connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: interaction.guildId,
    adapterCreator: interaction.guild.voiceAdapterCreator,
    selfDeaf: true
  });

  q.connection.subscribe(q.player);

  q.connection.on("error", error => {
    console.error("Voice connection error:", error);
  });

  return q.connection;
}

async function startNext(guildId) {
  const q = getQueue(guildId);
  if (!q || q.playing) return;

  const track = q.tracks.shift();

  if (!track) {
    q.current = null;
    return;
  }

  q.playing = true;
  q.current = track;

  try {
    // play-dl must be able to provide a compatible SoundCloud stream.
    const stream = await play.stream(track.url);

    const ffmpeg = spawn("ffmpeg", [
      "-hide_banner",
      "-loglevel", "error",
      "-i", "pipe:0",
      "-vn",
      "-f", "s16le",
      "-ar", "48000",
      "-ac", "2",
      "pipe:1"
    ], { stdio: ["pipe", "pipe", "pipe"] });

    stream.stream.pipe(ffmpeg.stdin);

    const resource = createAudioResource(ffmpeg.stdout, {
      inputType: require("@discordjs/voice").StreamType.Raw,
      metadata: track
    });

    q.player.play(resource);

    ffmpeg.on("error", error => {
      console.error("FFmpeg error:", error);
    });

    ffmpeg.stderr.on("data", data => {
      console.error("FFmpeg:", data.toString());
    });

  } catch (error) {
    console.error("Track playback failed:", error);
    q.playing = false;
    q.current = null;
    return startNext(guildId);
  }
}

function getOrCreateQueue(guildId) {
  let q = queues.get(guildId);

  if (!q) {
    const player = createAudioPlayer({
      behaviors: {
        noSubscriber: NoSubscriberBehavior.Pause
      }
    });

    q = {
      player,
      connection: null,
      tracks: [],
      current: null,
      playing: false
    };

    player.on(AudioPlayerStatus.Idle, () => {
      q.playing = false;
      q.current = null;
      startNext(guildId);
    });

    player.on("error", error => {
      console.error("Audio player error:", error);
      q.playing = false;
      q.current = null;
      startNext(guildId);
    });

    queues.set(guildId, q);
  }

  return q;
}

client.once(Events.ClientReady, async readyClient => {
  console.log(`Logged in as ${readyClient.user.tag}`);

  try {
    const rest = new REST({ version: "10" })
      .setToken(process.env.DISCORD_TOKEN);

    await rest.put(
      Routes.applicationCommands(readyClient.user.id),
      { body: commands }
    );

    console.log("Slash commands registered.");
  } catch (error) {
    console.error("Command registration failed:", error);
  }
});

client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const guildId = interaction.guildId;
  const name = interaction.commandName;

  try {
    if (name === "ping") {
      return interaction.reply("Pong! The bot is online.");
    }

    if (name === "playplaylist") {
      return interaction.reply(
        `Your playlist: ${PLAYLIST_URL}\n` +
        "This link identifies your playlist, but automatic YouTube Music playback is not connected yet."
      );
    }

    if (name === "play") {
      const url = interaction.options.getString("url", true);

      if (!/^https:\/\/soundcloud\.com\//i.test(url)) {
        return interaction.reply({
          content: "Please provide a public SoundCloud track URL.",
          ephemeral: true
        });
      }

      await interaction.deferReply();

      const info = await play.soundcloud(url);

      if (!info || !info.url) {
        return interaction.editReply(
          "I couldn't load that SoundCloud track."
        );
      }

      const q = getOrCreateQueue(guildId);

      connectToVoice(interaction, q);

      q.tracks.push({
        title: info.name || "SoundCloud track",
        url,
        user: interaction.user.username
      });

      if (!q.playing) startNext(guildId);

      return interaction.editReply(
        `Added to queue: **${info.name || url}**`
      );
    }

    const q = getQueue(guildId);

    if (name === "queue") {
      if (!q || (!q.current && !q.tracks.length)) {
        return interaction.reply("The queue is empty.");
      }

      const upcoming = q.tracks
        .slice(0, 10)
        .map((t, i) => `${i + 1}. ${t.title}`)
        .join("\n");

      return interaction.reply(
        `**Now playing:** ${q.current?.title || "Nothing"}\n` +
        `**Up next:**\n${upcoming || "No queued tracks"}`
      );
    }

    if (name === "nowplaying") {
      return interaction.reply(
        q?.current
          ? `Now playing: **${q.current.title}**`
          : "Nothing is playing right now."
      );
    }

    if (!q) {
      return interaction.reply({
        content: "Nothing is playing.",
        ephemeral: true
      });
    }

    if (name === "pause") {
      q.player.pause();
      return interaction.reply("Playback paused.");
    }

    if (name === "resume") {
      q.player.unpause();
      return interaction.reply("Playback resumed.");
    }

    if (name === "skip") {
      q.player.stop();
      return interaction.reply("Skipped the current track.");
    }

    if (name === "shuffle") {
      for (let i = q.tracks.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [q.tracks[i], q.tracks[j]] =
          [q.tracks[j], q.tracks[i]];
      }

      return interaction.reply("Shuffled the queue.");
    }

    if (name === "stop") {
      q.tracks = [];
      q.player.stop(true);

      if (q.connection) {
        q.connection.destroy();
        q.connection = null;
      }

      q.current = null;
      q.playing = false;

      return interaction.reply("Stopped playback and left voice.");
    }
  } catch (error) {
    console.error(error);

    const message =
      "Something went wrong. Check the hosting console for details.";

    if (interaction.deferred || interaction.replied) {
      return interaction.followUp({
        content: message,
        ephemeral: true
      }).catch(() => {});
    }

    return interaction.reply({
      content: message,
      ephemeral: true
    }).catch(() => {});
  }
});

client.login(process.env.DISCORD_TOKEN);
