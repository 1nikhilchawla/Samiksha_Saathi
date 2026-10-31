/** Deterministic code layer for Samiksha Saathi.
 *  Fixed data, no Math.random. Slide 3 counts are assertions, not decorations.
 *  The code lives in ./core by stage; import it from here.
 */
export * from "./core/config";
export * from "./core/model";
export * from "./core/ingest";
export * from "./core/seed";
export * from "./core/pipeline";
export * from "./core/gaps";
export * from "./core/guards";
export * from "./core/tasks";
export * from "./core/customTasks";
export * from "./core/scorecard";
export * from "./core/selfChecks";
export * from "./core/stateFormats";
export * from "./core/visionGuard";
export * from "./core/rbac";
export * from "./core/hingePoints";
export * from "./core/trustMeter";
export * from "./core/loopHealth";
export * from "./core/cleaningStudio";
export * from "./core/failureDiagnostics";
export * from "./core/uploadLimits";
export * from "./core/telegramFactCheck";
export * from "./core/messageQueue";
export * from "./core/cvPipeline";
export * from "./core/proofVault";
export * from "./core/layaEngine";
export * from "./core/habitRewards";
export * from "./core/smallSample";
export * from "./core/sessionToken";
export * from "./core/districtView";
