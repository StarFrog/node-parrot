"use strict";

const {Room, ManyRooms} = require("volapi");
const {util: vautil} = require("volapi");
const {Cooldown} = require("./utils");
const {Command} = require("../commands/command");

function parseCommandMap(config) {
  if (!config) {
    return new Map();
  }
  const rv = [];
  for (const cmd of Object.keys(config)) {
    let rooms = config[cmd];
    if (!Array.isArray(rooms)) {
      rooms = [rooms];
    }
    rv.push([cmd, rooms.map(e => vautil.parseId(e))]);
  }
  return new Map(rv);
}

class CommandWrapper {
  constructor(name, command, rooms) {
    let allowed = rooms && new Set(rooms);
    try {
      const more = new Set(
        Array.from(command.rooms).map(e => vautil.parseId(e)));
      if (allowed) {
        allowed = new Set(Array.from(allowed).filter(e => more.has(e)));
      }
      else {
        allowed = more;
      }
    }
    catch (ex) {
      // ignored;
    }

    this.name = name;
    this.command = command;
    this.allowed = allowed;
    Object.freeze(this);
  }

  has(room) {
    return !this.allowed ||
      this.allowed.has(room.id) || this.allowed.has(room.alias) ||
      this.allowed.has(room);
  }

  toString() {
    return this.name;
  }
}

class CommandHandler {
  constructor(mroom) {
    this.config = mroom.config;
    this.all = new Set();
    this.commandMap = parseCommandMap(this.config["command-map"]);
    this.commands = new Map();
    this.generic = new Set();
    this.always = new Set();
    this.files = new Set();
    this.pulses = new Set();
    this.intervals = [];
  }

  wrap(cmd, type) {
    if (!(cmd instanceof Command)) {
      throw new Error("Invalid command");
    }
    const cname = cmd.toString();
    const key = `${cname}:${type}`;
    if (this.all.has(key)) {
      throw Error("Command already registered");
    }
    this.all.add(key);
    console.debug(cname);
    const rooms = this.commandMap.get(cname);
    const wrapper = new CommandWrapper(cname, cmd, rooms);
    return wrapper;
  }

  registerChatCommand(cmd, always) {
    const wrapper = this.wrap(cmd, "chat");
    if (always) {
      this.always.add(wrapper);
      return;
    }
    if (!("handlers" in cmd)) {
      this.generic.add(wrapper);
      return;
    }
    let {handlers = []} = cmd;
    if (!Array.isArray(handlers)) {
      handlers = Array.of(handlers);
    }
    console.debug("handlers", handlers);
    for (const h of handlers) {
      this.commands.set(h, wrapper);
    }
  }

  registerFileCommand(cmd) {
    const wrapper = this.wrap(cmd, "file");
    this.files.add(wrapper);
  }

  registerPulseCommand(cmd) {
    const wrapper = this.wrap(cmd, "pulse");
    this.pulses.add(wrapper);
  }

  async loadAdditionalCommands(cmds, defaults) {
    for (let def of cmds) {
      if (typeof def === "string") {
        def = {cmd: def};
      }
      const {cmd, options} = def;
      const coptions = Object.assign({}, defaults, options);
      await Promise.resolve().then(() => require(cmd)(this, coptions)).
        catch(ex => {
          console.debug(ex);
          require.main.require(cmd)(this, coptions);
        }).
        catch(ex => {
          console.debug(ex);
          require.main.require(`./commands/${cmd}`)(this, coptions);
        }).
        catch(ex => {
          console.debug(ex);
          require(`${process.cwd()}/${cmd}`)(this, coptions);
        }).
        catch(ex => {
          console.debug(ex);
          require(`${process.cwd()}/node_modules/${cmd}`)(this, coptions);
        });
    }
  }

  startPulse() {
    this.intervals = Array.from(this.pulses).map(cmd => {
      try {
        let interval = cmd.command.interval | 0;
        interval -= (interval % 100);
        if (!interval) {
          return 0;
        }
        const iid = setInterval(async() => {
          try {
            let res = cmd.command.pulse();
            if (res && res.then) {
              res = await res;
            }
            if (res === false) {
              clearInterval(iid);
            }
          }
          catch (ex) {
            console.error("pulse", cmd.toString(), "failed".red, ex);
          }
        }, interval);
        return iid;
      }
      catch (ex) {
        console.debug(".pulse threw", ex);
      }
      return 0;
    }).filter(e => e);
  }

  stopPulse() {
    this.intervals.forEach(i => clearInterval(i));
  }
}

function toLower(arr) {
  return arr.map(e => e.toLowerCase());
}

class BotRoom extends Room {
  constructor(room, nick, options) {
    console.debug("constructor", room, nick, options);
    super(room, nick, options);
    const {botConfig = {}} = options;
    this.botConfig = botConfig;
    console.debug("inited room with config", botConfig);
  }

  get active() {
    return !!this.botConfig.active;
  }

  nonotify(str) {
    return `${str[0]}\u2060${str.substr(1)}`;
  }

  chat(msg, ...args) {
    if (msg.length > 298) {
      msg = `${msg.substr(0, 298)}…`;
    }
    if (!this.active) {
      return;
    }
    super.chat(msg, ...args);
  }

  chatNick(msg, maybeNick, text) {
    const nick = (maybeNick && maybeNick.trim()) || msg.nick;
    this.chat(`${nick}: ${text}`);
  }

  allowed(msg) {
    return msg && (!this.botConfig.greenmasterrace || !msg.white);
  }

  isAdmin(msg) {
    return msg.user && this.botConfig.admins.some(e => e === msg.lnick);
  }
}

class Runner extends ManyRooms {
  constructor(config) {
    config = Object.assign({active: true}, config, {
      admins: Array.from(new Set(toLower(config.admins || ["RealDolos"]))),
      blacked: Array.from(new Set(toLower(config.blacked || []))),
      obamas: Array.from(new Set(toLower(config.obamas || []))),
    });

    super(config.rooms, config.nick, Object.assign({
      Room: BotRoom,
      botConfig: config
    }, config.options));

    const {passwd = null} = config;
    this.passwd = passwd;
    this.config = config;
    delete this.config.rooms;
    delete this.config.options;
    delete this.config.passwd;

    this.obamas = new Cooldown(10 * 1000);
    this.handler = new CommandHandler(this);
  }

  async run() {
    const {commands = []} = this.config;
    delete this.config.commands;
    await this.handler.loadAdditionalCommands(commands, this.config);

    await super.init(this.passwd);
    this.on("close", (room, reason) => {
      console.info(
        "Room", room.toString().bold, "closed, because", reason.yellow);
    });
    this.on("error", (room, reason) => {
      console.info(
        "Room", room.toString().bold, "errored, because", reason.red);
    });
    this.on("chat", this.onchat.bind(this));
    this.on("file", this.onfile.bind(this));
    this.handler.startPulse();
    try {
      await super.connect();

      console.info("Parrot is now running");
      await super.run();
    }
    finally {
      this.handler.stopPulse();
      console.info("Parrot is done running");
    }
  }

  async onfile(room, file) {
    console.debug("file", file.toString());
    for (const handler of this.handler.files) {
      try {
        if (!handler.has(room)) {
          continue;
        }
        let res = handler.command.onfile(room, file);
        if (res && res.then) {
          res = await res;
        }
        if (res === true) {
          return;
        }
      }
      catch (ex) {
        console.error("File handler", handler.toString(), "threw", ex);
      }
    }
  }

  async onchat(room, msg) {
    if (msg.self || msg.system) {
      return;
    }
    console.info("msg", msg.toString());
    msg.lnick = msg.nick.toLowerCase();

    const always = [];
    for (const handler of this.handler.always) {
      try {
        if (!handler.has(room)) {
          continue;
        }
        always.push(handler.command.handle(room, msg));
      }
      catch (ex) {
        console.error("Always handler", handler.toString(), "threw", ex);
      }
    }

    if (this.config.blacked.some(e => msg.lnick.includes(e)) &&
      msg.lnick !== "modchatbot") {
      console.info("Ignored message from BLACKED", msg.nick);
      return;
    }
    if (this.config.obamas.some(e => msg.lnick.includes(e))) {
      if (this.obamas.has(msg.lnick)) {
        console.info("Ignored message from OBAMA", msg.nick);
        return;
      }
      this.obamas.set(msg.lnick);
    }

    try {
      const [cmd = "", remainder = ""] = msg.message.split(/\s+(.*)$/);
      if (!cmd) {
        return;
      }

      const specific = this.handler.commands.get(cmd);
      if (specific && specific.has(room)) {
        try {
          console.debug("calling specific", specific);
          let res = specific.command.handle(room, cmd, remainder, msg);
          if (res && res.then) {
            res = await res;
          }
          if (res === true) {
            return;
          }
        }
        catch (ex) {
          console.error("CommandHandler", specific.toString(), "threw", ex);
        }
      }

      for (const handler of this.handler.generic) {
        try {
          if (!handler.has(room)) {
            continue;
          }
          if (!handler.command.handles(room, cmd)) {
            console.debug("command does not handle", cmd);
            continue;
          }
          let res = handler.command.handle(room, cmd, remainder, msg);
          if (res && res.then) {
            res = await res;
          }
          if (res === true) {
            return;
          }
        }
        catch (ex) {
          console.error("Handler", handler.toString(), "threw", ex);
        }
      }
    }
    finally {
      try {
        if (always.length) {
          await Promise.all(always);
        }
      }
      catch (ex) {
        console.error("Async always threw", ex);
      }
    }
  }
}

module.exports = { Runner };
