/**
 * Skills — Workflow/SOP per intent.
 *
 * Skill adalah multi-step workflow yang bisa memanggil beberapa actions.
 * Berbeda dengan actions yang langsung eksekusi, skill bisa:
 *   - Mengecek kondisi (if/else)
 *   - Menunggu input user (next_state)
 *   - Menggabungkan beberapa actions
 *
 * Structure skill file:
 *   module.exports = {
 *     name: "nama_skill",
 *     description: "Deskripsi singkat",
 *     intent: "intent_name",      // Optional: trigger otomatis jika intent cocok
 *     execute: async function(context) {
 *       // context = { client, userPhone, message, decision, ... }
 *       // return { success: boolean, next_state: string, actions: [] }
 *     }
 *   };
 */

const logger = require("../utils/logger");
const fs = require("fs");
const path = require("path");

const SKILLS_DIR = path.join(__dirname);
let skillCache = null;

/**
 * Load semua skill dari directory.
 * Cache hasilnya sampai server restart (atau bisa pakai file watcher nanti).
 */
function loadSkills() {
  if (skillCache) return skillCache;

  skillCache = {};
  try {
    const files = fs.readdirSync(SKILLS_DIR).filter(f => f.endsWith(".js") && f !== "index.js");
    for (const file of files) {
      try {
        const skill = require(path.join(SKILLS_DIR, file));
        if (skill.name && typeof skill.execute === "function") {
          skillCache[skill.name] = skill;
          if (skill.intent) {
            skillCache[`intent:${skill.intent}`] = skill; // Alias berdasarkan intent
          }
        }
      } catch (err) {
        logger.warn("Skills: failed to load skill file", { file, error: err.message });
      }
    }
    logger.info("Skills loaded", { count: Object.keys(skillCache).length });
  } catch (err) {
    logger.error("Skills: failed to read skills directory", { error: err.message });
  }

  return skillCache;
}

/**
 * Cari skill berdasarkan nama atau intent.
 * @param {string} key - Nama skill atau intent
 * @returns {Object|null} Skill object, atau null jika tidak ditemukan
 */
function getSkill(key) {
  const skills = loadSkills();
  return skills[key] || skills[`intent:${key}`] || null;
}

/**
 * Eksekusi skill berdasarkan nama/intent.
 * @param {string} key             - Nama skill atau intent
 * @param {Object} context        - Context untuk skill execution
 * @returns {Object} { success, next_state, actions, response }
 */
async function executeSkill(key, context) {
  const skill = getSkill(key);
  if (!skill) {
    logger.debug("Skills: skill not found", { key });
    return { success: false, next_state: "", actions: [], response: "" };
  }

  try {
    logger.info("Skills: executing skill", { name: skill.name, intent: skill.intent });
    const result = await skill.execute(context);
    return {
      success:    true,
      next_state:  result.next_state  || "",
      actions:     Array.isArray(result.actions) ? result.actions : [],
      response:    result.response    || "",
    };
  } catch (err) {
    logger.error("Skills: execution failed", { name: skill.name, error: err.message });
    return { success: false, next_state: "", actions: [], response: "" };
  }
}

module.exports = { loadSkills, getSkill, executeSkill };
