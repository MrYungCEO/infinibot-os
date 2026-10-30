import type {
  HybridTeamPlan,
  HybridTeamRequest,
  SuitabilityRequest,
  SuitabilityResult,
  Worker,
  WorkerCapacity,
} from "./types.js";

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

export function scoreWorkerSuitability(
  worker: Worker,
  capacity: WorkerCapacity,
  request: SuitabilityRequest,
): SuitabilityResult {
  const reasons: string[] = [];
  const requiredSkills = request.requiredSkills ?? [];
  const skills = new Map(worker.skills.map((entry) => [normalize(entry.skill), entry]));
  const missingSkills: string[] = [];
  let earnedWeight = 0;
  let totalWeight = 0;

  for (const requirement of requiredSkills) {
    const weight = requirement.weight ?? 1;
    totalWeight += weight;
    const skill = skills.get(normalize(requirement.skill));
    if (!skill || skill.level < requirement.minimumLevel) {
      missingSkills.push(requirement.skill);
      continue;
    }
    earnedWeight += weight * Math.min(1, skill.level / requirement.minimumLevel);
  }

  const requiredCapabilities = request.requiredCapabilities ?? [];
  const capabilities = new Set(worker.capabilities.map(normalize));
  const missingCapabilities = requiredCapabilities.filter(
    (value) => !capabilities.has(normalize(value)),
  );
  const skillCoverage = totalWeight === 0 ? 1 : earnedWeight / totalWeight;
  const hoursNeeded = Math.max(0, request.estimatedHours ?? 0);
  const hasCapacity = capacity.remainingHours >= hoursNeeded;
  const costAllowed =
    request.maximumHourlyCost === undefined || worker.costRate <= request.maximumHourlyCost;
  const active = worker.employmentStatus === "active";

  let score = skillCoverage * 55;
  score += requiredCapabilities.length
    ? ((requiredCapabilities.length - missingCapabilities.length) / requiredCapabilities.length) *
      15
    : 15;
  score += Math.min(1, capacity.remainingHours / Math.max(1, hoursNeeded)) * 20;
  if (request.preferredType === worker.type) score += 5;
  if (costAllowed) score += 5;

  if (!active) reasons.push(`worker status is ${worker.employmentStatus}`);
  if (missingSkills.length) reasons.push(`missing required skills: ${missingSkills.join(", ")}`);
  if (missingCapabilities.length)
    reasons.push(`missing capabilities: ${missingCapabilities.join(", ")}`);
  if (!hasCapacity) reasons.push(`only ${capacity.remainingHours.toFixed(1)} hours available`);
  if (!costAllowed) reasons.push("hourly cost exceeds limit");
  if (reasons.length === 0)
    reasons.push("meets skills, capability, capacity, and cost constraints");

  return {
    workerId: worker.id,
    eligible:
      active &&
      missingSkills.length === 0 &&
      missingCapabilities.length === 0 &&
      hasCapacity &&
      costAllowed,
    score: Math.round(Math.max(0, Math.min(100, score)) * 10) / 10,
    skillCoverage: Math.round(skillCoverage * 1000) / 1000,
    availableHours: capacity.remainingHours,
    reasons,
    missingSkills,
    missingCapabilities,
  };
}

export function planHybridTeam(
  workers: Worker[],
  capacities: Map<string, WorkerCapacity>,
  request: HybridTeamRequest,
): HybridTeamPlan {
  const maximumTeamSize = Math.max(1, request.maximumTeamSize ?? 4);
  const ranked = workers
    .map((worker) => {
      const suitability = scoreWorkerSuitability(worker, capacities.get(worker.id)!, {
        ...request,
        estimatedHours: 0,
      });
      // A team member need not satisfy every skill alone: complementary coverage is
      // the point of a hybrid team. Employment, capacity, capability, and cost
      // constraints remain hard gates.
      const contributesSkill = !request.requiredSkills?.length || suitability.skillCoverage > 0;
      const teamEligible =
        worker.employmentStatus === "active" &&
        suitability.availableHours > 0 &&
        suitability.missingCapabilities.length === 0 &&
        (request.maximumHourlyCost === undefined || worker.costRate <= request.maximumHourlyCost) &&
        contributesSkill;
      return { worker, suitability: { ...suitability, eligible: teamEligible } };
    })
    .filter(({ suitability }) => suitability.eligible)
    .sort(
      (a, b) => b.suitability.score - a.suitability.score || a.worker.costRate - b.worker.costRate,
    );

  const selected: typeof ranked = [];
  const addBestType = (type: "human" | "ai") => {
    const candidate = ranked.find(
      (entry) =>
        entry.worker.type === type && !selected.some((item) => item.worker.id === entry.worker.id),
    );
    if (candidate) selected.push(candidate);
  };
  if (request.requireHuman ?? true) addBestType("human");
  if (request.requireAi ?? true) addBestType("ai");

  const requirements = request.requiredSkills ?? [];
  const covered = new Set<string>();
  const noteCoverage = (worker: Worker) => {
    for (const requirement of requirements) {
      const skill = worker.skills.find(
        (entry) => normalize(entry.skill) === normalize(requirement.skill),
      );
      if (skill && skill.level >= requirement.minimumLevel)
        covered.add(normalize(requirement.skill));
    }
  };
  selected.forEach((entry) => noteCoverage(entry.worker));

  for (const candidate of ranked) {
    if (selected.length >= maximumTeamSize || covered.size === requirements.length) break;
    if (selected.some((entry) => entry.worker.id === candidate.worker.id)) continue;
    const addsCoverage = requirements.some(
      (requirement) =>
        !covered.has(normalize(requirement.skill)) &&
        candidate.worker.skills.some(
          (skill) =>
            normalize(skill.skill) === normalize(requirement.skill) &&
            skill.level >= requirement.minimumLevel,
        ),
    );
    if (addsCoverage) {
      selected.push(candidate);
      noteCoverage(candidate.worker);
    }
  }

  const estimatedHours = Math.max(0, request.estimatedHours ?? 0);
  let hoursLeft = estimatedHours;
  const members = selected.map((entry, index) => {
    const slotsLeft = selected.length - index;
    const desired = hoursLeft / Math.max(1, slotsLeft);
    const allocatedHours = Math.min(entry.suitability.availableHours, desired);
    hoursLeft -= allocatedHours;
    return { ...entry, allocatedHours: Math.round(allocatedHours * 100) / 100 };
  });
  const warnings: string[] = [];
  if ((request.requireHuman ?? true) && !members.some((entry) => entry.worker.type === "human"))
    warnings.push("No eligible human worker is available");
  if ((request.requireAi ?? true) && !members.some((entry) => entry.worker.type === "ai"))
    warnings.push("No eligible AI worker is available");
  if (hoursLeft > 0.01) warnings.push(`${hoursLeft.toFixed(1)} estimated hours remain unallocated`);
  const missing = requirements.filter((requirement) => !covered.has(normalize(requirement.skill)));
  if (missing.length)
    warnings.push(`Team lacks required skills: ${missing.map((item) => item.skill).join(", ")}`);

  const totalHourlyCost = members.reduce((sum, entry) => sum + entry.worker.costRate, 0);
  const estimatedCost = members.reduce(
    (sum, entry) => sum + entry.worker.costRate * entry.allocatedHours,
    0,
  );
  return {
    members,
    skillCoverage: requirements.length
      ? (requirements.length - missing.length) / requirements.length
      : 1,
    totalHourlyCost,
    estimatedCost: Math.round(estimatedCost * 100) / 100,
    warnings,
  };
}
