const { withEntitlementsPlist } = require("expo/config-plugins");

module.exports = (config) =>
  withEntitlementsPlist(config, (result) => {
    if (config.extra.push) {
      result.modResults["aps-environment"] =
        config.extra.pushEnvironment === "sandbox" ? "development" : "production";
    } else {
      delete result.modResults["aps-environment"];
    }
    return result;
  });
