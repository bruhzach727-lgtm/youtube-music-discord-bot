
const {
  Client,
  GatewayIntentBits,
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
  StreamType
} = require("@discordjs/voice");

const play = require("play-dl");
const { spawn } = require("child_process");

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates]
});

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

const PLAYLIST_URL =
  "https://music.youtube.com/playlist?list=PLKdNkNcMbulo";

const commands = [
  new SlashCommandBuilder()
    .setName("play")
    .setDescription("Play a public SoundCloud track")
    .addStringOption(o =>
      o.setName("url").setDescription("SoundCloud track URL").setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("playplaylist")
    .setDescription("Show the YouTube Music playlist"),

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
    .setDescription("Stop playback and clear the queue"),

  new SlashCommandBuilder()
    .setName("nowplaying")
    .setDescription("Show the current track"),

  new SlashCommandBuilder()
    .setName("ping")
    .setDescription("Check bot latency")
].map(c => c.toJSON());

const queues = new Map();

function getQueue(guildId) {
  if (!queues.has(guildId)) {
    queues.set(guildId, {
      tracks: [],
      current: null,
      connection: null,
      player: createAudioPlayer({
        behaviors: {
          noSubscriber: NoSubscriberBehavior.Pause
        }
      }),
      busy: false
    });

    const q = queues.get(guildId);

    q.player.on(AudioPlayerStatus.Idle, () => {
      q.current = null;
      q.busy = false;
      playNext(guildId).catch(console.error);
    });

    q.player.on("error", error => {
      console.error("Audio player error:", error);
      q.current = null;
      q.busy = false;
      playNext(guildId).catch(console.error);
    });
  }

  return queues.get(guildId);
}

async function playNext(guildId) {
  const q = getQueue(guildId);

  if (q.busy || q.tracks.length === 0) return;

  q.busy = true;
  const track = q.tracks.shift();

  try {
    const stream = await play.stream(track.url);

    const ffmpeg = spawn("ffmpeg", [
      "-hide_banner",
      "-loglevel", "error",
      "-i", "pipe:0",
      "-f", "s16le",
      "-ar", "48000",
      "-ac", "2",
      "pipe:1"
    ]);

    stream.stream.pipe(ffmpeg.stdin);

    const resource = createAudioResource(ffmpeg.stdout, {
      inputType: StreamType.Raw,
      metadata: track
    });

    q.current = track;
    q.player.play(resource);

    ffmpeg.on("error", error => {
      console.error("FFmpeg error:", error);
    });

  } catch (error) {
    console.error("Could not play track:", error);
    q.current = null;
    q.busy = false;
    playNext(guildId).catch(console.error);
  }
}

async function connectToVoice(interaction) {
  const member = interaction.member;
  const channel = member?.voice?.channel;

  if (!channel) {
    throw new Error("Join a voice channel first.");
  }

  const q = getQueue(interaction.guildId);

  if (!q.connection) {
    q.connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: interaction.guildId,
      adapterCreator: interaction.guild.voiceAdapterCreator,
      selfDeaf: true
    });

    q.connection.subscribe(q.player);
  } else if (q.connection.joinConfig.channelId !== channel.id) {
    q.connection.destroy();

    q.connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: interaction.guildId,
      adapterCreator: interaction.guild.voiceAdapterCreator,
      selfDeaf: true
    });

    q.connection.subscribe(q.player);
  }

  return q;
}

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);

  if (!CLIENT_ID || !GUILD_ID) {
    console.error("Missing CLIENT_ID or GUILD_ID environment variables.");
    return;
  }

  try {
    const rest = new REST({ version: "10" }).setToken(TOKEN);

    await rest.put(
      Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
      { body: commands }
    );

    console.log("All 10 guild slash commands registered.");
  } catch (error) {
    console.error("Slash command registration failed:", error);
  }
});

client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const name = interaction.commandName;

  try {
    if (name === "ping") {
      return interaction.reply(`Pong! ${client.ws.ping}ms`);
    }

    if (name === "playplaylist") {
      return interaction.reply(
        `Your playlist: ${PLAYLIST_URL}\nAutomatic YouTube Music playlist playback is not implemented yet.`
      );
    }

    if (name === "play") {
      await interaction.deferReply();

      const url = interaction.options.getString("url", true);

      if (!/^https?:\/\/(www\.|m\.)?soundcloud\.com\//i.test(url)) {
        return interaction.editReply(
          "Please provide a public SoundCloud track URL."
        );
      }

      const q = await connectToVoice(interaction);

      q.tracks.push({
        url,
        title: url
      });

      await interaction.editReply("Added to the queue.");

      if (!q.busy) {
        playNext(interaction.guildId).catch(console.error);
      }

      return;
    }

    const q = getQueue(interaction.guildId);

    if (name === "queue") {
      const list = q.tracks
        .slice(0, 10)
        .map((t, i) => `${i + 1}. ${t.title}`)
        .join("\n");

      return interaction.reply({
        content:
          `**Now playing:** ${q.current?.title || "Nothing"}\n` +
          `**Up next:**\n${list || "Queue is empty."}`,
        allowedMentions: { parse: [] }
      });
    }

    if (name === "nowplaying") {
      return interaction.reply(
        q.current ? `Now playing: ${q.current.title}` : "Nothing is playing."
      );
    }

    if (name === "skip") {
      if (!q.current) {
        return interaction.reply("Nothing is playing.");
      }

      q.busy = false;
      q.player.stop(true);
      return interaction.reply("Skipped the current track.");
    }

    if (name === "pause") {
      return interaction.reply(
        q.player.pause() ? "Playback paused." : "Couldn't pause playback."
      );
    }

    if (name === "resume") {
      return interaction.reply(
        q.player.unpause() ? "Playback resumed." : "Couldn't resume playback."
      );
    }

    if (name === "shuffle") {
      for (let i = q.tracks.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [q.tracks[i], q.tracks[j]] = [q.tracks[j], q.tracks[i]];
      }

      return interaction.reply("Shuffled the queue.");
    }

    if (name === "stop") {
      q.tracks = [];
      q.current = null;
      q.busy = false;
      q.player.stop(true);

      if (q.connection) {
        q.connection.destroy();
        q.connection = null;
      }

      return interaction.reply("Stopped playback and cleared the queue.");
    }

  } catch (error) {
    console.error(error);

    const message = error.message || "An unexpected error occurred.";

    if (interaction.deferred || interaction.replied) {
      return interaction.editReply(`Error: ${message}`).catch(() => {});
    }

    return interaction.reply({
      content: `Error: ${message}`,
      ephemeral: true
    }).catch(() => {});
  }
});

if (!TOKEN) {
  console.error("Missing DISCORD_TOKEN environment variable.");
  process.exit(1);
}

client.login(TOKEN);
