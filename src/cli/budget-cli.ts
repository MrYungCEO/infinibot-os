/**
 * Budget CLI — API usage and cost tracking
 */

import type { Command } from "commander";
import { danger } from "../globals.js";
import { defaultRuntime } from "../runtime.js";
import { addGatewayClientOptions, callGatewayFromCli } from "./gateway-rpc.js";

export function registerBudgetCli(program: Command) {
  const budget = program
    .command("budget")
    .description("API usage and cost tracking");

  addGatewayClientOptions(
    budget.command("status")
      .description("Show current budget status")
      .option("--days <n>", "Days of history", "30")
      .option("--json", "Output as JSON", false)
      .action(async (opts) => {
        try {
          const result = await callGatewayFromCli("budget.status", opts, {
            days: parseInt(opts.days, 10),
          });

          if (opts.json) {
            console.log(JSON.stringify(result, null, 2));
          } else {
            console.log("Budget Status");
            console.log("─".repeat(50));
            
            const r = result as any;
            
            console.log(`Monthly Budget: $${r.monthly?.toFixed(2) || "N/A"}`);
            console.log(`Remaining:      $${r.remaining?.toFixed(2) || "N/A"}`);
            console.log(`Used This Month: $${r.usage?.month?.toFixed(2) || "0.00"}`);
            console.log(`Used Today:      $${r.usage?.today?.toFixed(2) || "0.00"}`);
            
            if (r.usage?.byProvider) {
              console.log("\nBy Provider:");
              for (const [provider, cost] of Object.entries(r.usage.byProvider)) {
                console.log(`  ${provider}: $${(cost as number).toFixed(2)}`);
              }
            }
          }
        } catch (err) {
          defaultRuntime.error(danger(String(err)));
          defaultRuntime.exit(1);
        }
      })
  );

  addGatewayClientOptions(
    budget.command("history")
      .description("Show usage history")
      .option("--days <n>", "Days of history", "7")
      .option("--provider <provider>", "Filter by provider")
      .option("--json", "Output as JSON", false)
      .action(async (opts) => {
        try {
          const result = await callGatewayFromCli("budget.history", opts, {
            days: parseInt(opts.days, 10),
            provider: opts.provider,
          });

          if (opts.json) {
            console.log(JSON.stringify(result, null, 2));
          } else {
            const entries = (result as any).entries || [];
            if (entries.length === 0) {
              console.log("No usage history found.");
              return;
            }

            console.log("Usage History");
            console.log("─".repeat(70));
            console.log("Date       | Provider   | Model              | Cost     | Tokens");
            console.log("─".repeat(70));
            
            for (const entry of entries) {
              const date = new Date(entry.timestamp).toLocaleDateString();
              const provider = (entry.provider || "").padEnd(10).slice(0, 10);
              const model = (entry.model || "").padEnd(18).slice(0, 18);
              const cost = `$${(entry.cost_usd || 0).toFixed(4)}`.padStart(8);
              const tokens = `${(entry.tokens_in || 0) + (entry.tokens_out || 0)}`.padStart(8);
              console.log(`${date} | ${provider} | ${model} | ${cost} | ${tokens}`);
            }
          }
        } catch (err) {
          defaultRuntime.error(danger(String(err)));
          defaultRuntime.exit(1);
        }
      })
  );

  addGatewayClientOptions(
    budget.command("route")
      .description("Get model routing recommendation for a task")
      .argument("<description>", "Task description")
      .option("--type <type>", "Task type (coding/research/chat/analysis)")
      .option("--provider <provider>", "Preferred provider")
      .option("--json", "Output as JSON", false)
      .action(async (description, opts) => {
        try {
          const result = await callGatewayFromCli("budget.route", opts, {
            description,
            task_type: opts.type,
            preferred_provider: opts.provider,
          });

          if (opts.json) {
            console.log(JSON.stringify(result, null, 2));
          } else {
            const r = result as any;
            console.log("Routing Recommendation");
            console.log("─".repeat(40));
            console.log(`Provider:   ${r.provider || "N/A"}`);
            console.log(`Model:      ${r.model || "N/A"}`);
            console.log(`Complexity: ${r.complexity || "N/A"}`);
            console.log(`Reasoning:  ${r.reason || "N/A"}`);
          }
        } catch (err) {
          defaultRuntime.error(danger(String(err)));
          defaultRuntime.exit(1);
        }
      })
  );

  addGatewayClientOptions(
    budget.command("record")
      .description("Manually record API usage")
      .requiredOption("--provider <provider>", "Provider name")
      .requiredOption("--model <model>", "Model name")
      .requiredOption("--cost <cost>", "Cost in USD")
      .option("--tokens-in <n>", "Input tokens")
      .option("--tokens-out <n>", "Output tokens")
      .option("--title <title>", "Usage title/description")
      .option("--json", "Output as JSON", false)
      .action(async (opts) => {
        try {
          const result = await callGatewayFromCli("budget.record", opts, {
            provider: opts.provider,
            model: opts.model,
            cost_usd: parseFloat(opts.cost),
            tokens_in: opts.tokensIn ? parseInt(opts.tokensIn, 10) : undefined,
            tokens_out: opts.tokensOut ? parseInt(opts.tokensOut, 10) : undefined,
            title: opts.title,
          });

          if (opts.json) {
            console.log(JSON.stringify(result, null, 2));
          } else {
            console.log(`✓ Recorded usage: $${opts.cost} for ${opts.provider}/${opts.model}`);
          }
        } catch (err) {
          defaultRuntime.error(danger(String(err)));
          defaultRuntime.exit(1);
        }
      })
  );

  addGatewayClientOptions(
    budget.command("subscriptions")
      .description("List provider subscriptions")
      .option("--json", "Output as JSON", false)
      .action(async (opts) => {
        try {
          const result = await callGatewayFromCli("budget.subscriptions", opts, {});

          if (opts.json) {
            console.log(JSON.stringify(result, null, 2));
          } else {
            const subs = (result as any).subscriptions || [];
            if (subs.length === 0) {
              console.log("No subscriptions configured.");
              return;
            }

            console.log("Provider Subscriptions");
            console.log("─".repeat(50));
            
            for (const sub of subs) {
              const cost = sub.monthlyCost ? `$${sub.monthlyCost}/mo` : "free";
              const included = sub.includedTokens ? `${sub.includedTokens} tokens` : "";
              console.log(`${sub.provider.padEnd(15)} | ${cost.padEnd(10)} | ${included}`);
            }
          }
        } catch (err) {
          defaultRuntime.error(danger(String(err)));
          defaultRuntime.exit(1);
        }
      })
  );

  addGatewayClientOptions(
    budget.command("set")
      .description("Set monthly budget limit")
      .argument("<amount>", "Monthly budget in USD")
      .action(async (amount, opts) => {
        try {
          await callGatewayFromCli("budget.set", opts, {
            monthly: parseFloat(amount),
          });
          console.log(`✓ Set monthly budget to $${amount}`);
        } catch (err) {
          defaultRuntime.error(danger(String(err)));
          defaultRuntime.exit(1);
        }
      })
  );

  addGatewayClientOptions(
    budget.command("alert")
      .description("Set budget alert threshold")
      .argument("<percent>", "Alert when usage exceeds this % of budget")
      .action(async (percent, opts) => {
        try {
          await callGatewayFromCli("budget.alert", opts, {
            threshold: parseFloat(percent) / 100,
          });
          console.log(`✓ Set alert threshold to ${percent}%`);
        } catch (err) {
          defaultRuntime.error(danger(String(err)));
          defaultRuntime.exit(1);
        }
      })
  );
}
