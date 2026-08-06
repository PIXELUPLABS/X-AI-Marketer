// Typefully API v2 adapter. One interface, two paths:
//   live: real API calls (media upload is a two-step presigned flow)
//   dry:  writes the EXACT would-be request body to outbox/<run_id>/draft-NN.json
// The outbox file IS the payload we'd send — validating it against the contract
// validates the integration minus auth.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

export class TypefullyClient {
  /** @param {object} cfg loaded config  @param {string} runId for outbox pathing in dry mode */
  constructor(cfg, runId) {
    this.cfg = cfg;
    this.runId = runId;
    this.dry = cfg.dryRun;
    this.base = cfg.typefully.base_url;
    this.socialSetId = cfg.typefully.social_set_id;
    this.mediaSeq = 0;
    this.draftSeq = 0;
  }

  async #req(method, urlPath, body) {
    const res = await fetch(`${this.base}${urlPath}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.cfg.env.TYPEFULLY_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`Typefully ${method} ${urlPath} -> ${res.status} ${await res.text()}`);
    return res.json();
  }

  /** Used by --check mode to resolve/verify social_set_id. Live only. */
  async getSocialSets() {
    if (this.dry) return { results: [{ id: "dryrun-social-set", username: "dryrun" }] };
    return this.#req("GET", "/social-sets");
  }

  /**
   * Two-step presigned upload, then poll until processed.
   * @returns {Promise<{media_id: string}>}
   */
  async uploadMedia(filePath) {
    if (this.dry) {
      this.mediaSeq += 1;
      return { media_id: `dryrun-media-${String(this.mediaSeq).padStart(2, "0")}` };
    }
    const fileName = path.basename(filePath);
    const { media_id, upload_url } = await this.#req(
      "POST",
      `/social-sets/${this.socialSetId}/media/upload`,
      { file_name: fileName },
    );
    // Plain PUT, raw bytes only, no extra headers — per the API docs.
    const put = await fetch(upload_url, { method: "PUT", body: readFileSync(filePath) });
    if (!put.ok) throw new Error(`media PUT ${fileName} -> ${put.status}`);

    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const status = await this.#req("GET", `/social-sets/${this.socialSetId}/media/${media_id}`);
      if (status.status === "ready") return { media_id };
      if (status.status === "failed") throw new Error(`media processing failed for ${fileName}`);
      await new Promise((r) => setTimeout(r, 2000));
    }
    throw new Error(`media processing timeout (60s) for ${fileName}`);
  }

  /**
   * Create a 2-tweet X thread draft. draft_mode "planned" -> plan_at (inert,
   * human must confirm in Typefully); "scheduled" -> publish_at (AUTO-PUBLISHES).
   * @param {{posts: Array<{text: string, media?: Array<{media_id: string}>}>, slotIso: string}} args
   * @returns {Promise<{id: string, outbox_file?: string}>}
   */
  async createDraft({ posts, slotIso }) {
    const dateField = this.cfg.typefully.draft_mode === "planned" ? "plan_at" : "publish_at";
    const body = {
      platforms: { x: { enabled: true, posts } },
      [dateField]: slotIso,
    };

    if (this.dry) {
      const n = String((this.draftSeq += 1)).padStart(2, "0");
      const dir = path.join(this.cfg.abs.outbox_dir, this.runId);
      mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `draft-${n}.json`);
      writeFileSync(
        file,
        JSON.stringify(
          {
            _would_send: `POST ${this.base}/social-sets/${this.socialSetId}/drafts`,
            body,
          },
          null,
          2,
        ) + "\n",
      );
      return { id: `dryrun-draft-${n}`, outbox_file: file };
    }

    const draft = await this.#req("POST", `/social-sets/${this.socialSetId}/drafts`, body);
    return { id: draft.id };
  }
}
