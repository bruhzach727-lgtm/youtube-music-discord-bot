const { Client, GatewayIntentBits, Events, REST, Routes, SlashCommandBuilder } = require("discord.js");

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates]
});

const commands = [
  new SlashCommandBuilder().setName("playplaylist").setDescription("Show your YouTube Music playlist"),
  new SlashCommandBuilder().setName("playlist").setDescription("Get your playlist link"),
  new SlashCommandBuilder().setName("ping").setDescription("Check if the bot is online")
].map(command => command.toJSON());

const playlistURL = "https://music.youtube.com/playlist?list=PLKdNkNcMbulo";

client.once(Events.ClientReady, async readyClient => {
  console.log(`Logged in as ${readyClient.user.tag}`);

  try {
    const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
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

  if (interaction.commandName === "ping") {
    return interaction.reply("Pong! The bot is online.");
  }

  if (interaction.commandName === "playlist" ||
      interaction.commandName === "playplaylist") {
    return interaction.reply({
      content: `Your playlist: ${playlistURL}\n\nThis is the playlist link; audio playback has not been connected yet.`,
      ephemeral: true
    });
  }
});

client.login(process.env.DISCORD_TOKEN);
