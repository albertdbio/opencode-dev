import { describe, expect, test } from "bun:test"
import path from "path"
import { pathToFileURL } from "url"
import { Effect, Layer } from "effect"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { ModelsDev } from "@opencode-ai/core/models-dev"
import { provideInstance, TestInstance, tmpdirScoped } from "../fixture/fixture"
import { ProviderAuth } from "@/provider/auth"
import { Provider } from "@/provider/provider"

import { Plugin } from "@/plugin"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Auth } from "@/auth"
import { Env } from "@/env"
import { EventV2Bridge } from "@/event-v2-bridge"
import { TestConfig } from "../fixture/config"
import { testEffect } from "../lib/effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { ProviderV2 } from "@opencode-ai/core/provider"

const it = testEffect(Layer.mergeAll(CrossSpawnSpawner.defaultLayer, AppFileSystem.defaultLayer))

function layer(directory: string, plugins: string[]) {
  return ProviderAuth.layer.pipe(
    Layer.provide(Auth.defaultLayer),
    Layer.provide(
      Plugin.layer.pipe(
        Layer.provide(EventV2Bridge.defaultLayer),
        Layer.provide(RuntimeFlags.layer()),
        Layer.provide(
          TestConfig.layer({
            get: () =>
              Effect.succeed({
                plugin: plugins,
                plugin_origins: plugins.map((plugin) => ({
                  spec: plugin,
                  source: path.join(directory, "opencode.json"),
                  scope: "local" as const,
                })),
              }),
            directories: () => Effect.succeed([directory]),
          }),
        ),
      ),
    ),
  )
}

function providerLayer(directory: string, plugins: string[]) {
  const config = TestConfig.layer({
    get: () =>
      Effect.succeed({
        plugin: plugins,
        plugin_origins: plugins.map((plugin) => ({
          spec: plugin,
          source: path.join(directory, "opencode.json"),
          scope: "local" as const,
        })),
        provider: {
          "subscription-test": {
            name: "Subscription Test",
            npm: "@ai-sdk/openai-compatible",
            api: "https://example.com/v1",
            models: {
              "paid-model": {
                name: "Paid Model",
                cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
              },
            },
          },
        },
      }),
    directories: () => Effect.succeed([directory]),
  })

  return Provider.layer.pipe(
    Layer.provide(AppFileSystem.defaultLayer),
    Layer.provide(Env.defaultLayer),
    Layer.provide(config),
    Layer.provide(Auth.defaultLayer),
    Layer.provide(ModelsDev.defaultLayer),
    Layer.provide(RuntimeFlags.layer()),
    Layer.provide(
      Plugin.layer.pipe(
        Layer.provide(EventV2Bridge.defaultLayer),
        Layer.provide(RuntimeFlags.layer()),
        Layer.provide(Auth.defaultLayer),
        Layer.provide(config),
      ),
    ),
  )
}

describe("plugin.auth-override", () => {
  it.instance(
    "user plugin overrides built-in github-copilot auth",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const fs = yield* AppFileSystem.Service
        const pluginDir = path.join(tmp.directory, ".opencode", "plugin")

        yield* fs.writeWithDirs(
          path.join(pluginDir, "custom-copilot-auth.ts"),
          [
            "export default {",
            '  id: "demo.custom-copilot-auth",',
            "  server: async () => ({",
            "    auth: {",
            '      provider: "github-copilot",',
            "      methods: [",
            '        { type: "api", label: "Test Override Auth" },',
            "      ],",
            "      loader: async () => ({ access: 'test-token' }),",
            "    },",
            "  }),",
            "}",
            "",
          ].join("\n"),
        )

        const plain = yield* tmpdirScoped({ git: true })
        const plugin = pathToFileURL(path.join(pluginDir, "custom-copilot-auth.ts")).href
        const methods = yield* ProviderAuth.use.methods().pipe(Effect.provide(layer(tmp.directory, [plugin])))
        const plainMethods = yield* ProviderAuth.use
          .methods()
          .pipe(Effect.provide(layer(plain, [])), provideInstance(plain))

        const copilot = methods[ProviderV2.ID.make("github-copilot")]
        expect(copilot).toBeDefined()
        expect(copilot.length).toBe(1)
        expect(copilot[0].label).toBe("Test Override Auth")
        expect(plainMethods[ProviderV2.ID.make("github-copilot")][0].label).not.toBe("Test Override Auth")
      }),
    { git: true },
    30000,
  )

  it.instance(
    "auth loader model cost mutation applies to resolved provider models",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const fs = yield* AppFileSystem.Service
        const pluginDir = path.join(tmp.directory, ".opencode", "plugin")

        yield* fs.writeWithDirs(
          path.join(pluginDir, "subscription-auth.ts"),
          [
            "export default {",
            '  id: "demo.subscription-auth",',
            "  server: async () => ({",
            "    auth: {",
            '      provider: "subscription-test",',
            '      methods: [{ type: "oauth", label: "Subscription" }],',
            "      loader: async (_getAuth, provider) => {",
            "        for (const model of Object.values(provider.models ?? {})) {",
            "          model.cost = { input: 0, output: 0, cache: { read: 0, write: 0 } }",
            "        }",
            "        return {}",
            "      },",
            "    },",
            "  }),",
            "}",
            "",
          ].join("\n"),
        )

        const plugin = pathToFileURL(path.join(pluginDir, "subscription-auth.ts")).href
        const original = process.env.OPENCODE_AUTH_CONTENT
        yield* Effect.sync(() => {
          process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({
            "subscription-test": { type: "oauth", refresh: "refresh", access: "access", expires: 1 },
          })
        })
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (original === undefined) delete process.env.OPENCODE_AUTH_CONTENT
            else process.env.OPENCODE_AUTH_CONTENT = original
          }),
        )

        const model = yield* Provider.use
          .getModel(ProviderV2.ID.make("subscription-test"), ProviderV2.ModelID.make("paid-model"))
          .pipe(Effect.provide(providerLayer(tmp.directory, [plugin])))

        expect(model.cost.input).toBe(0)
        expect(model.cost.output).toBe(0)
        expect(model.cost.cache.read).toBe(0)
        expect(model.cost.cache.write).toBe(0)
      }),
    { git: true },
    30000,
  )
})

const file = path.join(import.meta.dir, "../../src/plugin/index.ts")

describe("plugin.config-hook-error-isolation", () => {
  test("config hooks are individually error-isolated in the layer factory", async () => {
    const src = await Bun.file(file).text()

    // Each hook's config call is wrapped in Effect.tryPromise with error logging + Effect.ignore
    expect(src).toContain("plugin config hook failed")

    const pattern =
      /for\s*\(const hook of hooks\)\s*\{[\s\S]*?Effect\.tryPromise[\s\S]*?\.config\?\.\([\s\S]*?plugin config hook failed[\s\S]*?Effect\.ignore/
    expect(pattern.test(src)).toBe(true)
  })
})
