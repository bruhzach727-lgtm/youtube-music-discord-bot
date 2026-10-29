
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

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates
  ]
});

const PLAYLIST_URL =
  "https://music.youtube.com/playlist?list=PLKdNkNcMbulo";

const commands = [
  new SlashCommandBuilder()
    .setName("play")
    .setDescription("Play a supported audio URL")
    .addStringOption(o =>
      o.setName("url")
        .setDescription("Public audio track URL")
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("playplaylist")
    .setDescription("Show the YouTube Music playlist"),
  new SlashCommandBuilder().setName("skip").setDescription("Skip the current track"),
  new SlashCommandBuilder().setName("pause").setDescription("Pause playback"),
  new SlashCommandBuilder().setName("resume").setDescription("Resume playback"),
  new SlashCommandBuilder().setName("queue").setDescription("Show the queue"),
  new SlashCommandBuilder().setName("shuffle").setDescription("Shuffle the queue"),
  new SlashCommandBuilder().setName("stop").setDescription("Stop and clear the queue"),
  new SlashCommandBuilder().setName("nowplaying").setDescription("Show the current track"),
  new SlashCommandBuilder().setName("ping").setDescription("Check bot latency")
].map(command => command.toJSON());

const queues = new Map();

function getQueue(guildId) {
  if (!queues.has(guildId)) {
    const player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Pause }
    });

    const q = {
      tracks: [],
      current: null,
      connection: null,
      player,
      busy: false,
      generation: 0
    };

    player.on(AudioPlayerStatus.Idle, () => {
      q.current = null;
      q.busy = false;
      playNext(guildId).catch(console.error);
    });

    player.on("error", error => {
      console.error("Audio player error:", error.message);
      q.current = null;
      q.busy = false;
      playNext(guildId).catch(console.error);
    });

    queues.set(guildId, q);
  }

  return queues.get(guildId);
}

async function connectToVoice(interaction) {
  const channel = interaction.member?.voice?.channel;

  if (!channel) {
    throw new Error("Join a voice channel first.");
  }

  const q = getQueue(interaction.guildId);

  if (!q.connection ||
      q.connection.state.status === "destroyed") {
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

async function playNext(guildId) {
  const q = getQueue(guildId);

  if (q.busy || q.tracks.length === 0) return;

  q.busy = true;
  const generation = q.generation;
  const track = q.tracks.shift();

  let ffmpeg;

  try {
    // Resolve the URL through play-dl's stream API.
    const result = await play.stream(track.url);

    if (generation !== q.generation) return;

    ffmpeg = spawn("ffmpeg", [
      "-hide_banner",
      "-loglevel", "error",
      "-i", "pipe:0",
      "-f", "s16le",
      "-ar", "48000",
      "-ac", "2",
      "pipe:1"
    ]);

    result.stream.pipe(ffmpeg.stdin);

    ffmpeg.on("error", error => {
      console.error("FFmpeg error:", error.message);
    });

    ffmpeg.stderr.on("data", data => {
      console.error("FFmpeg:", data.toString());
    });

    const resource = createAudioResource(ffmpeg.stdout, {
      inputType: StreamType.Raw,
      metadata: track
    });

    q.current = track;
    q.player.play(resource);

  } catch (error) {
    if (ffmpeg) ffmpeg.kill();
    console.error("Track playback failed:", error.message);
    q.current = null;
    q.busy = false;

    if (generation === q.generation) {
      playNext(guildId).catch(console.error);
    }
  }
}

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);

  if (!CLIENT_ID || !GUILD_ID) {
    console.error("Set CLIENT_ID and GUILD_ID in hosting environment variables.");
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
    console.error("Command registration failed:", error);
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
        `Playlist: ${PLAYLIST_URL}\nAutomatic playlist playback is not enabled in this version.`
      );
    }

    if (name === "play") {
      await interaction.deferReply();

      const url = interaction.options.getString("url", true);

      if (!/^https?:\/\//i.test(url)) {
        return interaction.editReply("Enter a valid public URL.");
      }

      const q = await connectToVoice(interaction);

      q.tracks.push({ url, title: url });

      if (!q.busy) {
        playNext(interaction.guildId).catch(console.error);
      }

      return interaction.editReply("Added to the queue. Trying to load the track...");
    }

    const q = getQueue(interaction.guildId);

    if (name === "queue") {
      const upcoming = q.tracks.slice(0, 10)
        .map((track, i) => `${i + 1}. ${track.title}`)
        .join("\n");

      return interaction.reply(
        `**Now playing:** ${q.current?.title || "Nothing"}\n**Up next:**\n${upcoming || "Queue is empty."}`
      );
    }

    if (name === "nowplaying") {
      return interaction.reply(
        q.current ? `Now playing: ${q.current.title}` : "Nothing is playing."
      );
    }

    if (name === "skip") {
      if (!q.current) return interaction.reply("Nothing is playing.");
      q.player.stop(true);
      return interaction.reply("Skipped.");
    }

    if (name === "pause") {
      return interaction.reply(
        q.player.pause() ? "Paused." : "Could not pause playback."
      );
    }

    if (name === "resume") {
      return interaction.reply(
        q.player.unpause() ? "Resumed." : "Could not resume playback."
      );
    }

    if (name === "shuffle") {
      for (let i = q.tracks.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [q.tracks[i], q.tracks[j]] = [q.tracks[j], q.tracks[i]];
      }

      return interaction.reply("Queue shuffled.");
    }

    if (name === "stop") {
      q.generation++;
      q.tracks = [];
      q.current = null;
      q.busy = false;
      q.player.stop(true);

      if (q.connection) {
        q.connection.destroy();
        q.connection = null;
      }

      return interaction.reply("Stopped and cleared the queue.");
    }
  } catch (error) {
    console.error("Command error:", error);

    const message = `Error: ${error.message || "Unknown error"}`;

    if (interaction.deferred || interaction.replied) {
      return interaction.editReply(message).catch(() => {});
    }

    return interaction.reply({
      content: message,
      ephemeral: true
    }).catch(() => {});
  }
});

if (!TOKEN) {
  console.error("Missing DISCORD_TOKEN environment variable.");
  process.exit(1);
}

client.login(TOKEN);
