"use strict";

const DEFAULTS = [
  "admin",
  "chen",
  "parrot",
  "pulse",
  "tard",
  "collector",
  "web",
  "info",
];

module.exports = async function(handler, options) {
  console.debug(options);
  for (const d of DEFAULTS) {
    console.debug(`Loading ${d}...`);
    await require(`./${d}`)(handler, options);
  }
};
