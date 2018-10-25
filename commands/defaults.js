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
  "request",
];

module.exports = async function(handler, options) {
  console.debug(options);
  for (const d of DEFAULTS) {
    await require(`./${d}`)(handler, options);
  }
};
