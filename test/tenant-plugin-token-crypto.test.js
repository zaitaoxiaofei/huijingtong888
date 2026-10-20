import assert from "node:assert/strict";
import test from "node:test";
import {
  decryptTenantPluginToken,
  encryptTenantPluginToken,
  tenantPluginTokenEncryptionConfigured
} from "../src/services/tenant-plugin-token-crypto.js";

const keyName = "TENANT_PLUGIN_TOKEN_ENCRYPTION_KEY";
const fallbackKeyName = "SELLER_ANALYTICS_AUTH_ENCRYPTION_KEY";

function withKeys(values, callback) {
  const previous = Object.fromEntries([keyName, fallbackKeyName].map(name => [name, process.env[name]]));
  for (const name of [keyName, fallbackKeyName]) {
    if (values[name] === undefined) delete process.env[name];
    else process.env[name] = values[name];
  }
  try {
    return callback();
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test("tenant plugin tokens can be repeatedly recovered from authenticated ciphertext", () => {
  withKeys({ [keyName]: "a-stable-test-key-that-is-at-least-32-characters" }, () => {
    const token = "ozp_test-token-do-not-log";
    const encrypted = encryptTenantPluginToken(token);
    assert.match(encrypted, /^v1:/);
    assert.equal(encrypted.includes(token), false);
    assert.equal(decryptTenantPluginToken(encrypted), token);
    assert.equal(decryptTenantPluginToken(encrypted), token);
  });
});

test("tenant token crypto accepts the established stable seller encryption key as fallback", () => {
  withKeys({ [fallbackKeyName]: "a-stable-seller-key-that-is-at-least-32-characters" }, () => {
    const encrypted = encryptTenantPluginToken("ozp_test-token");
    assert.equal(tenantPluginTokenEncryptionConfigured(), true);
    assert.equal(decryptTenantPluginToken(encrypted), "ozp_test-token");
  });
});

test("tenant token crypto refuses to encrypt without a stable server key", () => {
  withKeys({}, () => {
    assert.equal(tenantPluginTokenEncryptionConfigured(), false);
    assert.throws(() => encryptTenantPluginToken("ozp_test-token"), /TENANT_PLUGIN_TOKEN_ENCRYPTION_KEY/);
  });
});

test("tenant token decryption rejects legacy hashes and mismatched keys", () => {
  withKeys({ [keyName]: "a-stable-test-key-that-is-at-least-32-characters" }, () => {
    assert.throws(() => decryptTenantPluginToken(""), /旧版凭证/);
    const encrypted = encryptTenantPluginToken("ozp_test-token");
    withKeys({ [keyName]: "a-different-stable-key-that-is-also-over-32-characters" }, () => {
      assert.throws(() => decryptTenantPluginToken(encrypted), /无法解密/);
    });
  });
});
