/**
 * Producer Agent
 *
 * Orchestrates "agentic producer" flow:
 * 1) Draft Score Plan from prompt (schema-guided).
 * 2) Generate music via JSON-RPC gateway.
 * 3) Run critics to quality-gate the result.
 * 4) Refine the plan and retry (bounded attempts).
 */

const { BaseAgent, AgentRole, AgentCapabilities } = require('./base-agent');
const { PythonBridge } = require('../python-bridge');
const fs = require('fs');
const path = require('path');

const DEFAULT_MAX_ITERATIONS = 2;
const DEFAULT_BPM = 90;
const DEFAULT_KEY = 'C';
const DEFAULT_MODE = 'minor';
const DEFAULT_TIME_SIGNATURE = [4, 4];
const DEFAULT_DIRECTOR_MODEL = 'claude-sonnet-4.5';
const DEFAULT_PRODUCER_MODEL = 'gpt-4.1';
const DEFAULT_VERIFIER_MODEL = 'claude-sonnet-4.5';

class ProducerAgent extends BaseAgent {
  constructor(options = {}) {
    super({
      ...options,
      role: AgentRole.PRODUCER,
      name: options.name || 'producer',
      description: 'Creates score plans, generates music, and runs quality critics',
      capabilities: [
        AgentCapabilities.SEARCH,
        AgentCapabilities.READ,
        AgentCapabilities.EXECUTE,
        AgentCapabilities.TODO,
        AgentCapabilities.HANDOFF
      ]
    });

    this.pythonBridge = null;
    this._scorePlanSchemaCache = null;
  }

  getSystemPrompt() {
    return `You are the PRODUCER agent in a multi-agent music system.

# ROLE
- Generate a valid Score Plan (score_plan_v1) for MUSE.
- Keep plans musically coherent and production-aware.
- Return JSON only (no markdown) when asked to output a plan.

# QUALITY
- Prefer clear section structures and instrument roles.
- Use musically sensible BPM, key, mode, and arrangement.

# SAFETY
- Do not remove features or disable existing behavior.
- Keep outputs deterministic and schema-compliant.`;
  }

  async process(task, context = {}) {
    const prompt = this._extractPrompt(task);
    const maxIterations = Number(context.maxIterations || DEFAULT_MAX_ITERATIONS);
    const allowCriticGateFailure = Boolean(
      context.allowCriticGateFailure ||
      context.generationOnlySuccess ||
      context.allowQualityGateBypass
    );
    const referenceInput = this._resolveReferenceInput(prompt, context);
    const modelPolicy = this._resolveModelPolicy(context);

    const builder = this.orchestrator?.getBuilder?.();
    const verifier = this.orchestrator?.getVerifier?.();
    if (!builder) {
      return { success: false, error: 'Producer requires Builder agent access' };
    }
    if (!verifier) {
      return { success: false, error: 'Producer requires Verifier agent access' };
    }

    const referenceProfile = await this._analyzeReference(referenceInput);
    let scorePlan = await this._createScorePlan(prompt, referenceProfile, modelPolicy);

    const planningTelemetry = {
      roleModels: {
        director: modelPolicy.director,
        producer: modelPolicy.producer,
        verifier: modelPolicy.verifier
      },
      referenceUsed: !!referenceProfile,
      referenceSource: referenceInput || null,
      timestamp: new Date().toISOString()
    };

    this.log('info', 'Producer model policy selected', planningTelemetry);
    const phaseStates = [];
    this._pushPhaseState(phaseStates, 'producer_start', 0.02, 'Producer orchestration started');

    const validationTelemetry = [];

    const initialValidation = this._prepareValidatedScorePlan(scorePlan, prompt, 'initial');
    scorePlan = initialValidation.plan;
    validationTelemetry.push(initialValidation);
    this._pushPhaseState(phaseStates, 'score_plan_validation', 0.12, initialValidation.validBefore ? 'Initial score plan validated' : 'Initial score plan required fallback');

    scorePlan = this._normalizeScorePlan(scorePlan, prompt);

    let lastResult = null;
    let lastCritics = null;
    let lastOutputAnalysis = null;
    const preflightTelemetry = [];

    for (let attempt = 1; attempt <= maxIterations; attempt++) {
      this.log('info', 'Producer attempt starting', { attempt, maxIterations });
      this._pushPhaseState(phaseStates, `attempt_${attempt}_start`, 0.15 + ((attempt - 1) * (0.7 / Math.max(1, maxIterations))), `Attempt ${attempt}/${maxIterations} started`);

      const attemptValidation = this._prepareValidatedScorePlan(scorePlan, prompt, `attempt_${attempt}`);
      scorePlan = attemptValidation.plan;
      validationTelemetry.push(attemptValidation);
      this._pushPhaseState(phaseStates, `attempt_${attempt}_validation`, 0.2 + ((attempt - 1) * (0.7 / Math.max(1, maxIterations))), attemptValidation.validBefore ? 'Attempt plan validated' : 'Attempt plan fallback applied');

      const preflight = await verifier.preflightScorePlanGate(scorePlan, {
        prompt,
        model: modelPolicy.verifier
      });
      preflightTelemetry.push({ attempt, ...preflight });
      this._pushPhaseState(phaseStates, `attempt_${attempt}_preflight`, 0.25 + ((attempt - 1) * (0.7 / Math.max(1, maxIterations))), preflight.passed ? 'Preflight gate passed' : 'Preflight gate failed');

      if (!preflight.passed) {
        this.log('warn', 'Preflight gate failed before generation', {
          attempt,
          issues: preflight.issues
        });

        if (attempt < maxIterations) {
          const syntheticCritic = {
            report: {
              summary: `Preflight gate failed: ${(preflight.issues || []).slice(0, 5).join('; ')}`
            }
          };
          scorePlan = await this._refineScorePlan(prompt, scorePlan, syntheticCritic, referenceProfile, modelPolicy);
          scorePlan = this._normalizeScorePlan(scorePlan, prompt);
          continue;
        }

        return {
          success: false,
          terminalOutcome: 'PRECHECK_FAILED',
          response: this._formatFailureResponse(scorePlan, lastResult, lastCritics, maxIterations, {
            preflight,
            outputAnalysis: lastOutputAnalysis
          }),
          scorePlan,
          generation: lastResult,
          critics: lastCritics,
          outputAnalysis: lastOutputAnalysis,
          planningTelemetry,
          validationTelemetry,
          preflightTelemetry,
          phaseStates
        };
      }

      lastResult = await builder.generateMusicFromScorePlan(scorePlan, {
        prompt,
        trackProgress: true
      });
      this._pushPhaseState(phaseStates, `attempt_${attempt}_generation`, 0.55 + ((attempt - 1) * (0.35 / Math.max(1, maxIterations))), 'Generation run completed');

      if (!lastResult || !lastResult.midi_path) {
        this.log('error', 'Music generation failed', { attempt, result: lastResult });
        return {
          success: false,
          terminalOutcome: 'GENERATION_FAILED',
          error: 'Generation failed or missing midi_path',
          attempt,
          result: lastResult,
          planningTelemetry,
          validationTelemetry,
          preflightTelemetry,
          phaseStates
        };
      }

      lastCritics = await verifier.runMusicCritics(lastResult.midi_path, scorePlan.genre);
      this._pushPhaseState(phaseStates, `attempt_${attempt}_critics`, 0.72 + ((attempt - 1) * (0.2 / Math.max(1, maxIterations))), lastCritics?.passed ? 'Critics passed' : 'Critics failed');

      if (lastResult.audio_path) {
        try {
          lastOutputAnalysis = await verifier.analyzeRenderedOutput(
            lastResult.audio_path,
            scorePlan.genre || 'pop'
          );
          this._pushPhaseState(phaseStates, `attempt_${attempt}_output_analysis`, 0.82 + ((attempt - 1) * (0.16 / Math.max(1, maxIterations))), 'Output analysis complete');
        } catch (error) {
          lastOutputAnalysis = {
            passed: false,
            error: error.message
          };
          this._pushPhaseState(phaseStates, `attempt_${attempt}_output_analysis`, 0.82 + ((attempt - 1) * (0.16 / Math.max(1, maxIterations))), `Output analysis failed: ${error.message}`);
        }
      }

      if (lastCritics.passed) {
        this._pushPhaseState(phaseStates, 'producer_complete', 1.0, 'Producer completed successfully');
        return {
          success: true,
          terminalOutcome: 'COMPLETED_SUCCESS',
          response: this._formatSuccessResponse(scorePlan, lastResult, lastCritics, attempt, {
            outputAnalysis: lastOutputAnalysis,
            preflight: preflightTelemetry[preflightTelemetry.length - 1] || null
          }),
          scorePlan,
          generation: lastResult,
          critics: lastCritics,
          outputAnalysis: lastOutputAnalysis,
          planningTelemetry,
          validationTelemetry,
          preflightTelemetry,
          phaseStates
        };
      }

      if (allowCriticGateFailure && lastResult && lastResult.midi_path) {
        this._pushPhaseState(phaseStates, 'producer_complete', 1.0, 'Producer completed with critic-gate bypass');
        return {
          success: true,
          terminalOutcome: 'COMPLETED_WITH_CRITIC_FAIL_ACCEPTED',
          response: this._formatSuccessResponse(scorePlan, lastResult, lastCritics, attempt, {
            outputAnalysis: lastOutputAnalysis,
            preflight: preflightTelemetry[preflightTelemetry.length - 1] || null,
            criticGateBypassed: true
          }),
          scorePlan,
          generation: lastResult,
          critics: lastCritics,
          outputAnalysis: lastOutputAnalysis,
          planningTelemetry,
          validationTelemetry,
          preflightTelemetry,
          phaseStates
        };
      }

      if (attempt < maxIterations) {
        scorePlan = await this._refineScorePlan(prompt, scorePlan, lastCritics, referenceProfile, modelPolicy);
        scorePlan = this._normalizeScorePlan(scorePlan, prompt);
      }
    }

    return {
      success: false,
      terminalOutcome: 'COMPLETED_WITH_CRITIC_FAIL',
      response: this._formatFailureResponse(scorePlan, lastResult, lastCritics, maxIterations, {
        preflight: preflightTelemetry[preflightTelemetry.length - 1] || null,
        outputAnalysis: lastOutputAnalysis,
        suggestBypass: true
      }),
      scorePlan,
      generation: lastResult,
      critics: lastCritics,
      outputAnalysis: lastOutputAnalysis,
      planningTelemetry,
      validationTelemetry,
      preflightTelemetry,
      phaseStates
    };
  }

  _pushPhaseState(target, step, percent, message, extra = {}) {
    target.push({
      step,
      percent: Math.max(0, Math.min(1, Number(percent) || 0)),
      message,
      timestamp: new Date().toISOString(),
      ...extra
    });
  }

  async ensurePythonBridge() {
    if (!this.pythonBridge) {
      this.pythonBridge = PythonBridge.getShared();
    }
    if (!this.pythonBridge.isRunning) {
      await this.pythonBridge.start();
    }
    return this.pythonBridge;
  }

  _extractPrompt(task) {
    if (!task) return '';
    if (typeof task === 'string') return task.trim();
    if (typeof task.prompt === 'string') return task.prompt.trim();
    if (typeof task.description === 'string') return task.description.trim();
    return '';
  }

  _schemaPath() {
    return path.resolve(__dirname, '..', '..', '..', '..', 'MUSE', 'docs', 'muse-specs', 'schemas', 'score_plan.v1.schema.json');
  }

  _loadSchema() {
    try {
      const schemaPath = this._schemaPath();
      return fs.readFileSync(schemaPath, 'utf-8');
    } catch (error) {
      this.log('warn', 'Failed to load score plan schema', { error: error.message });
      return null;
    }
  }

  _loadScorePlanSchema() {
    if (this._scorePlanSchemaCache) {
      return this._scorePlanSchemaCache;
    }
    try {
      const schemaText = this._loadSchema();
      if (!schemaText) return null;
      this._scorePlanSchemaCache = JSON.parse(schemaText);
      return this._scorePlanSchemaCache;
    } catch (error) {
      this.log('warn', 'Failed to parse score plan schema JSON', { error: error.message });
      return null;
    }
  }

  async _createScorePlan(prompt, referenceProfile = null, modelPolicy = null) {
    const schemaText = this._loadSchema();
    const referenceContext = this._formatReferenceContext(referenceProfile);
    const policy = modelPolicy || { director: DEFAULT_DIRECTOR_MODEL, producer: DEFAULT_PRODUCER_MODEL };

    const directorGuidance = await this._draftDirectorGuidance(prompt, referenceProfile, policy.director);

    const baseInstruction = `Create a score_plan_v1 JSON for this prompt.
Prompt: ${prompt}

${referenceContext}

Director guidance (creative intent):
${directorGuidance}

Rules:
- Output JSON ONLY (no markdown).
- Must satisfy required fields in the schema.
- Keep instruments realistic and varied.
`;

    const promptWithSchema = schemaText
      ? `${baseInstruction}\nSchema:\n${schemaText}`
      : baseInstruction;

    const response = await this.chat(promptWithSchema, { model: policy.producer });
    const jsonText = this._extractJson(response.text);
    if (!jsonText) {
      this.log('warn', 'Failed to parse score plan JSON, falling back');
      return {};
    }
    try {
      return JSON.parse(jsonText);
    } catch (error) {
      this.log('warn', 'Score plan JSON parse error', { error: error.message });
      return {};
    }
  }

  async _refineScorePlan(prompt, previousPlan, critics, referenceProfile = null, modelPolicy = null) {
    const schemaText = this._loadSchema();
    const criticSummary = critics?.report?.summary || 'Critics failed without a summary.';
    const referenceContext = this._formatReferenceContext(referenceProfile);
    const policy = modelPolicy || { director: DEFAULT_DIRECTOR_MODEL, producer: DEFAULT_PRODUCER_MODEL };
    const baseInstruction = `Refine the previous score_plan_v1 JSON to address critics.
Prompt: ${prompt}
Critic summary: ${criticSummary}

${referenceContext}

Rules:
- Output JSON ONLY (no markdown).
- Preserve the prompt and keep schema validity.
`;

    const promptWithSchema = schemaText
      ? `${baseInstruction}\nPrevious plan:\n${JSON.stringify(previousPlan, null, 2)}\nSchema:\n${schemaText}`
      : `${baseInstruction}\nPrevious plan:\n${JSON.stringify(previousPlan, null, 2)}`;

    const response = await this.chat(promptWithSchema, { model: policy.producer });
    const jsonText = this._extractJson(response.text);
    if (!jsonText) {
      return previousPlan;
    }
    try {
      return JSON.parse(jsonText);
    } catch (_error) {
      return previousPlan;
    }
  }

  _normalizeScorePlan(plan, prompt) {
    const normalized = (plan && typeof plan === 'object') ? { ...plan } : {};
    normalized.schema_version = 'score_plan_v1';
    normalized.prompt = (normalized.prompt && String(normalized.prompt).trim()) || prompt || 'Music generation';

    const bpm = Number(normalized.bpm);
    normalized.bpm = Number.isFinite(bpm) ? Math.min(220, Math.max(30, bpm)) : DEFAULT_BPM;

    const key = typeof normalized.key === 'string' ? normalized.key.trim() : DEFAULT_KEY;
    normalized.key = /^[A-G](#|b)?$/.test(key) ? key : DEFAULT_KEY;

    const mode = typeof normalized.mode === 'string' ? normalized.mode : DEFAULT_MODE;
    const allowedModes = new Set(['major', 'minor', 'dorian', 'phrygian', 'lydian', 'mixolydian', 'locrian']);
    normalized.mode = allowedModes.has(mode) ? mode : DEFAULT_MODE;

    if (!Array.isArray(normalized.time_signature) || normalized.time_signature.length !== 2) {
      normalized.time_signature = DEFAULT_TIME_SIGNATURE;
    }

    if (!Array.isArray(normalized.sections) || normalized.sections.length === 0) {
      normalized.sections = [
        { name: 'Intro', type: 'intro', bars: 8, energy: 0.2, tension: 0.2 },
        { name: 'Verse', type: 'verse', bars: 16, energy: 0.35, tension: 0.3 },
        { name: 'Chorus', type: 'chorus', bars: 16, energy: 0.6, tension: 0.5 },
        { name: 'Outro', type: 'outro', bars: 8, energy: 0.2, tension: 0.2 }
      ];
    }

    if (!Array.isArray(normalized.tracks) || normalized.tracks.length === 0) {
      normalized.tracks = [
        { role: 'pad', instrument: 'Atmospheric Pad', density: 0.7 },
        { role: 'strings', instrument: 'Warm Strings', density: 0.5 },
        { role: 'keys', instrument: 'Soft Piano', density: 0.4 },
        { role: 'bass', instrument: 'Sub Bass', density: 0.3 },
        { role: 'fx', instrument: 'Drone FX', density: 0.2 }
      ];
    }

    return normalized;
  }

  _prepareValidatedScorePlan(plan, prompt, stage = 'unknown') {
    const normalized = this._normalizeScorePlan(plan, prompt);
    const schema = this._loadScorePlanSchema();
    const sanitized = this._sanitizeScorePlanToSchemaSubset(normalized, schema);
    const before = this._validateScorePlanStrict(sanitized);

    if (before.valid) {
      return {
        stage,
        validBefore: true,
        validAfter: true,
        fallbackApplied: false,
        errorsBefore: [],
        errorsAfter: [],
        plan: sanitized
      };
    }

    const fallbackPlan = this._buildFallbackScorePlan(prompt, sanitized);
    const fallbackSanitized = this._sanitizeScorePlanToSchemaSubset(fallbackPlan, schema);
    const after = this._validateScorePlanStrict(fallbackSanitized);

    if (!after.valid) {
      this.log('warn', 'Fallback score plan still failed strict validation', {
        stage,
        errors: after.errors
      });
    }

    return {
      stage,
      validBefore: false,
      validAfter: after.valid,
      fallbackApplied: true,
      errorsBefore: before.errors,
      errorsAfter: after.errors,
      plan: fallbackSanitized
    };
  }

  _sanitizeScorePlanToSchemaSubset(plan, _schema = null) {
    const src = (plan && typeof plan === 'object') ? plan : {};

    const topAllowed = new Set([
      'schema_version', 'request_id', 'prompt', 'bpm', 'key', 'mode',
      'time_signature', 'genre', 'mood', 'influences', 'seed', 'duration_bars',
      'sections', 'chord_map', 'tension_curve', 'cue_points', 'tracks', 'constraints'
    ]);

    const out = {};
    for (const [key, value] of Object.entries(src)) {
      if (topAllowed.has(key)) out[key] = value;
    }

    if (Array.isArray(out.time_signature)) {
      out.time_signature = out.time_signature.slice(0, 2).map(v => Number(v));
    }

    if (Array.isArray(out.sections)) {
      out.sections = out.sections
        .filter(s => s && typeof s === 'object')
        .map(s => ({
          name: s.name,
          type: s.type,
          bars: Number(s.bars),
          energy: s.energy !== undefined ? Number(s.energy) : undefined,
          tension: s.tension !== undefined ? Number(s.tension) : undefined
        }));
    }

    if (Array.isArray(out.tracks)) {
      out.tracks = out.tracks
        .filter(t => t && typeof t === 'object')
        .map(t => ({
          role: t.role,
          instrument: t.instrument,
          pattern_hint: t.pattern_hint,
          octave: t.octave !== undefined ? Number(t.octave) : undefined,
          density: t.density !== undefined ? Number(t.density) : undefined,
          activation: Array.isArray(t.activation)
            ? t.activation
                .filter(a => a && typeof a === 'object')
                .map(a => ({ section: a.section, active: !!a.active }))
            : undefined
        }));
    }

    if (Array.isArray(out.chord_map)) {
      out.chord_map = out.chord_map
        .filter(c => c && typeof c === 'object')
        .map(c => ({ bar: Number(c.bar), chord: c.chord }));
    }

    if (Array.isArray(out.cue_points)) {
      out.cue_points = out.cue_points
        .filter(c => c && typeof c === 'object')
        .map(c => ({
          bar: Number(c.bar),
          type: c.type,
          intensity: c.intensity !== undefined ? Number(c.intensity) : undefined
        }));
    }

    if (out.constraints && typeof out.constraints === 'object') {
      out.constraints = {
        avoid_instruments: Array.isArray(out.constraints.avoid_instruments) ? out.constraints.avoid_instruments : undefined,
        avoid_drums: Array.isArray(out.constraints.avoid_drums) ? out.constraints.avoid_drums : undefined,
        max_polyphony: out.constraints.max_polyphony !== undefined ? Number(out.constraints.max_polyphony) : undefined
      };
    }

    const pruneUndefined = (obj) => {
      if (Array.isArray(obj)) return obj.map(pruneUndefined);
      if (obj && typeof obj === 'object') {
        const cleaned = {};
        for (const [k, v] of Object.entries(obj)) {
          if (v !== undefined) cleaned[k] = pruneUndefined(v);
        }
        return cleaned;
      }
      return obj;
    };

    return pruneUndefined(out);
  }

  _validateScorePlanStrict(plan) {
    const errors = [];
    const allowedModes = new Set(['major', 'minor', 'dorian', 'phrygian', 'lydian', 'mixolydian', 'locrian']);
    const allowedSectionTypes = new Set(['intro', 'verse', 'pre_chorus', 'chorus', 'drop', 'bridge', 'breakdown', 'outro']);
    const allowedTrackRoles = new Set(['drums', 'bass', 'keys', 'lead', 'strings', 'fx', 'pad']);
    const allowedCueTypes = new Set(['fill', 'build', 'drop', 'breakdown']);

    const required = ['schema_version', 'prompt', 'bpm', 'key', 'mode', 'sections', 'tracks'];
    for (const key of required) {
      if (plan[key] === undefined || plan[key] === null) {
        errors.push(`Missing required field: ${key}`);
      }
    }

    if (plan.schema_version !== 'score_plan_v1') {
      errors.push('schema_version must be score_plan_v1');
    }

    if (typeof plan.prompt !== 'string' || !plan.prompt.trim()) {
      errors.push('prompt must be a non-empty string');
    }

    if (typeof plan.bpm !== 'number' || Number.isNaN(plan.bpm) || plan.bpm < 30 || plan.bpm > 220) {
      errors.push('bpm must be a number in [30,220]');
    }

    if (typeof plan.key !== 'string' || !/^[A-G](#|b)?$/.test(plan.key)) {
      errors.push('key must match ^[A-G](#|b)?$');
    }

    if (!allowedModes.has(plan.mode)) {
      errors.push('mode must be one of the allowed modes');
    }

    if (plan.time_signature !== undefined) {
      const ts = plan.time_signature;
      if (!Array.isArray(ts) || ts.length !== 2 || !Number.isInteger(ts[0]) || !Number.isInteger(ts[1]) || ts[0] < 1 || ts[1] < 1) {
        errors.push('time_signature must be [int>=1, int>=1]');
      }
    }

    if (!Array.isArray(plan.sections) || plan.sections.length < 1) {
      errors.push('sections must be a non-empty array');
    } else {
      plan.sections.forEach((s, i) => {
        if (!s || typeof s !== 'object') {
          errors.push(`sections[${i}] must be an object`);
          return;
        }
        if (typeof s.name !== 'string' || !s.name) errors.push(`sections[${i}].name required`);
        if (!allowedSectionTypes.has(s.type)) errors.push(`sections[${i}].type invalid`);
        if (!Number.isInteger(s.bars) || s.bars < 1) errors.push(`sections[${i}].bars must be int>=1`);
        if (s.energy !== undefined && (typeof s.energy !== 'number' || s.energy < 0 || s.energy > 1)) {
          errors.push(`sections[${i}].energy must be in [0,1]`);
        }
        if (s.tension !== undefined && (typeof s.tension !== 'number' || s.tension < 0 || s.tension > 1)) {
          errors.push(`sections[${i}].tension must be in [0,1]`);
        }
      });
    }

    if (!Array.isArray(plan.tracks) || plan.tracks.length < 1) {
      errors.push('tracks must be a non-empty array');
    } else {
      plan.tracks.forEach((t, i) => {
        if (!t || typeof t !== 'object') {
          errors.push(`tracks[${i}] must be an object`);
          return;
        }
        if (!allowedTrackRoles.has(t.role)) errors.push(`tracks[${i}].role invalid`);
        if (typeof t.instrument !== 'string' || !t.instrument) errors.push(`tracks[${i}].instrument required`);
        if (t.density !== undefined && (typeof t.density !== 'number' || t.density < 0 || t.density > 1)) {
          errors.push(`tracks[${i}].density must be in [0,1]`);
        }
        if (t.activation !== undefined) {
          if (!Array.isArray(t.activation)) {
            errors.push(`tracks[${i}].activation must be an array`);
          } else {
            t.activation.forEach((a, j) => {
              if (!a || typeof a !== 'object') {
                errors.push(`tracks[${i}].activation[${j}] must be object`);
                return;
              }
              if (typeof a.section !== 'string' || !a.section) errors.push(`tracks[${i}].activation[${j}].section required`);
              if (typeof a.active !== 'boolean') errors.push(`tracks[${i}].activation[${j}].active must be boolean`);
            });
          }
        }
      });
    }

    if (plan.chord_map !== undefined) {
      if (!Array.isArray(plan.chord_map)) {
        errors.push('chord_map must be an array');
      } else {
        plan.chord_map.forEach((c, i) => {
          if (!c || typeof c !== 'object') {
            errors.push(`chord_map[${i}] must be object`);
            return;
          }
          if (!Number.isInteger(c.bar) || c.bar < 1) errors.push(`chord_map[${i}].bar must be int>=1`);
          if (typeof c.chord !== 'string' || !c.chord) errors.push(`chord_map[${i}].chord required`);
        });
      }
    }

    if (plan.cue_points !== undefined) {
      if (!Array.isArray(plan.cue_points)) {
        errors.push('cue_points must be an array');
      } else {
        plan.cue_points.forEach((c, i) => {
          if (!c || typeof c !== 'object') {
            errors.push(`cue_points[${i}] must be object`);
            return;
          }
          if (!Number.isInteger(c.bar) || c.bar < 1) errors.push(`cue_points[${i}].bar must be int>=1`);
          if (!allowedCueTypes.has(c.type)) errors.push(`cue_points[${i}].type invalid`);
          if (c.intensity !== undefined && (typeof c.intensity !== 'number' || c.intensity < 0 || c.intensity > 1)) {
            errors.push(`cue_points[${i}].intensity must be in [0,1]`);
          }
        });
      }
    }

    if (plan.constraints !== undefined) {
      const c = plan.constraints;
      if (!c || typeof c !== 'object' || Array.isArray(c)) {
        errors.push('constraints must be an object');
      } else if (c.max_polyphony !== undefined && (!Number.isInteger(c.max_polyphony) || c.max_polyphony < 1)) {
        errors.push('constraints.max_polyphony must be int>=1');
      }
    }

    return { valid: errors.length === 0, errors };
  }

  _buildFallbackScorePlan(prompt, candidate = {}) {
    const safePrompt = (candidate.prompt && String(candidate.prompt).trim()) || prompt || 'Music generation';
    return {
      schema_version: 'score_plan_v1',
      prompt: safePrompt,
      bpm: DEFAULT_BPM,
      key: DEFAULT_KEY,
      mode: DEFAULT_MODE,
      time_signature: DEFAULT_TIME_SIGNATURE,
      genre: typeof candidate.genre === 'string' ? candidate.genre : undefined,
      mood: typeof candidate.mood === 'string' ? candidate.mood : undefined,
      sections: [
        { name: 'Intro', type: 'intro', bars: 8, energy: 0.2, tension: 0.2 },
        { name: 'Verse', type: 'verse', bars: 16, energy: 0.35, tension: 0.3 },
        { name: 'Chorus', type: 'chorus', bars: 16, energy: 0.6, tension: 0.5 },
        { name: 'Outro', type: 'outro', bars: 8, energy: 0.2, tension: 0.2 }
      ],
      tracks: [
        { role: 'pad', instrument: 'Atmospheric Pad', density: 0.7 },
        { role: 'strings', instrument: 'Warm Strings', density: 0.5 },
        { role: 'keys', instrument: 'Soft Piano', density: 0.4 },
        { role: 'bass', instrument: 'Sub Bass', density: 0.3 },
        { role: 'fx', instrument: 'Drone FX', density: 0.2 }
      ]
    };
  }

  _extractJson(text) {
    if (!text || typeof text !== 'string') return null;
    const stripped = text.trim().replace(/^```json/i, '').replace(/^```/i, '').replace(/```$/i, '').trim();
    if (stripped.startsWith('{') && stripped.endsWith('}')) {
      return stripped;
    }
    const start = stripped.indexOf('{');
    if (start === -1) return null;
    let depth = 0;
    for (let i = start; i < stripped.length; i++) {
      const ch = stripped[i];
      if (ch === '{') depth += 1;
      if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          return stripped.slice(start, i + 1);
        }
      }
    }
    return null;
  }

  _resolveReferenceInput(prompt, context = {}) {
    if (context.referenceUrl && typeof context.referenceUrl === 'string') {
      return context.referenceUrl.trim();
    }
    if (context.referencePath && typeof context.referencePath === 'string') {
      return context.referencePath.trim();
    }
    if (context.reference && typeof context.reference === 'string') {
      return context.reference.trim();
    }
    return this._extractFirstUrl(prompt);
  }

  _resolveModelPolicy(context = {}) {
    const policy = context.modelPolicy && typeof context.modelPolicy === 'object'
      ? context.modelPolicy
      : {};

    return {
      director: policy.director || context.directorModel || DEFAULT_DIRECTOR_MODEL,
      producer: policy.producer || context.producerModel || DEFAULT_PRODUCER_MODEL,
      verifier: policy.verifier || context.verifierModel || DEFAULT_VERIFIER_MODEL
    };
  }

  _extractFirstUrl(text) {
    if (!text || typeof text !== 'string') return null;
    const match = text.match(/https?:\/\/[^\s)]+/i);
    return match ? match[0] : null;
  }

  async _analyzeReference(referenceInput) {
    if (!referenceInput) return null;
    try {
      const bridge = await this.ensurePythonBridge();
      const key = /^https?:\/\//i.test(referenceInput) ? 'url' : 'file_path';
      const profile = await bridge.call('analyze_reference', {
        [key]: referenceInput,
        include_genre_in_hints: false
      }, 120000);
      this.log('info', 'Reference analysis complete', {
        source: referenceInput,
        bpm: profile?.bpm,
        key: profile?.key,
        mode: profile?.mode
      });
      return profile;
    } catch (error) {
      this.log('warn', 'Reference analysis failed; continuing without it', {
        source: referenceInput,
        error: error.message
      });
      return null;
    }
  }

  async _draftDirectorGuidance(prompt, referenceProfile, directorModel) {
    const referenceContext = this._formatReferenceContext(referenceProfile);
    const instruction = `You are the Director role. Produce concise creative direction for song planning (not JSON).
Prompt: ${prompt}

${referenceContext}

Return 6-10 bullet points covering: form, energy arc, rhythm feel, harmony color, instrumentation priorities, and mix aesthetic.`;

    try {
      const response = await this.chat(instruction, { model: directorModel });
      return response?.text || 'No director guidance available.';
    } catch (error) {
      this.log('warn', 'Director guidance failed; fallback to prompt-only planning', {
        model: directorModel,
        error: error.message
      });
      return 'Director guidance unavailable; use prompt and reference profile only.';
    }
  }

  _formatReferenceContext(profile) {
    if (!profile || typeof profile !== 'object') {
      return 'Reference profile: none.';
    }

    const compact = {
      source: profile.source,
      title: profile.title,
      bpm: profile.bpm,
      key: profile.key,
      mode: profile.mode,
      estimated_genre: profile.estimated_genre,
      style_tags: profile.style_tags,
      prompt_hints: profile.prompt_hints,
      generation_params: profile.generation_params
    };

    return `Reference profile (ground truth from Python audio analysis):\n${JSON.stringify(compact, null, 2)}\nUse it to guide tempo/key/feel, but keep the final score plan coherent with the user prompt.`;
  }

  _formatSuccessResponse(plan, generation, critics, attempt, extras = {}) {
    const title = generation.title || generation.output_name || generation.output_filename || 'Generated track';
    const midiPath = generation.midi_path || 'unknown';
    const audioPath = generation.audio_path || generation.wav_path || 'unknown';
    const criticsSummary = critics?.report?.summary || 'Critics passed.';
    const preflightStatus = extras?.preflight?.passed === false ? 'FAIL' : 'PASS';
    const outputScore = extras?.outputAnalysis && typeof extras.outputAnalysis.genre_match_score !== 'undefined'
      ? extras.outputAnalysis.genre_match_score
      : 'n/a';
    const outputPass = extras?.outputAnalysis && typeof extras.outputAnalysis.passed !== 'undefined'
      ? extras.outputAnalysis.passed
      : 'n/a';
    const criticBypassLine = extras?.criticGateBypassed ? '\nCritic Gate Bypass: enabled (generation accepted despite critic failure).' : '';
    return `Producer completed in ${attempt} attempt(s).
Title: ${title}
Prompt: ${plan.prompt}
Key/Mode: ${plan.key} ${plan.mode}
BPM: ${plan.bpm}
MIDI: ${midiPath}
Audio: ${audioPath}
Preflight Gate: ${preflightStatus}
Critics: ${criticsSummary}
Output Analysis: passed=${outputPass}, genre_match_score=${outputScore}${criticBypassLine}`;
  }

  _formatFailureResponse(plan, generation, critics, attempts, extras = {}) {
    const criticsSummary = critics?.report?.summary || 'Critics failed.';
    const preflightStatus = extras?.preflight?.passed === false ? 'FAIL' : 'n/a';
    const outputScore = extras?.outputAnalysis && typeof extras.outputAnalysis.genre_match_score !== 'undefined'
      ? extras.outputAnalysis.genre_match_score
      : 'n/a';
    const bypassHint = extras?.suggestBypass
      ? '\nTip: Use /produce --accept-generation <prompt> to accept generated output even when critics fail.'
      : '';
    return `Producer failed after ${attempts} attempt(s).
Prompt: ${plan?.prompt || 'unknown'}
Last result: ${generation?.midi_path || 'no midi'}
Preflight Gate: ${preflightStatus}
Critics: ${criticsSummary}
Output Analysis Score: ${outputScore}${bypassHint}`;
  }
}

module.exports = { ProducerAgent };
