const OBLIVION_FORGEJO_AGENT_USERNAMES: Record<string, string> = {
  'oblivion-phantasy-agent': 'oblivion-phantasy',
  'oblivion-hermes-agent': 'oblivion-hermes',
  'oblivion-openclaw-agent': 'oblivion-openclaw',
  'oblivion-opencode-agent': 'oblivion-opencode',
};

const OBLIVION_RUNTIME_AGENTS = [
  {
    name: 'Oblivion Phantasy',
    agentFrameworkId: 'oblivion-phantasy-agent',
    title: 'Oblivion Marketing',
    bio: 'Phantasy runtime for Oblivion docs, trust-center, and marketing quests.',
    frameworkType: 'phantasy',
    avatarSeed: 'oblivion-phantasy',
    defaultCallbackUrl: 'http://127.0.0.1:2100/admin/api/webhooks/party-quest',
    budgetUsd: 60,
  },
  {
    name: 'Oblivion Hermes',
    agentFrameworkId: 'oblivion-hermes-agent',
    title: 'Oblivion Research',
    bio: 'Hermes bridge for broker and policy research on Oblivion.',
    frameworkType: 'hermes',
    avatarSeed: 'oblivion-hermes',
    defaultCallbackUrl: 'http://127.0.0.1:2101/admin/api/webhooks/party-quest',
    budgetUsd: 40,
  },
  {
    name: 'Oblivion OpenClaw',
    agentFrameworkId: 'oblivion-openclaw-agent',
    title: 'Oblivion Debug',
    bio: 'OpenClaw bridge for CI failure triage and debugging.',
    frameworkType: 'openclaw',
    avatarSeed: 'oblivion-openclaw',
    defaultCallbackUrl: 'http://127.0.0.1:2102/admin/api/webhooks/party-quest',
    budgetUsd: 40,
  },
  {
    name: 'Oblivion OpenCode',
    agentFrameworkId: 'oblivion-opencode-agent',
    title: 'Oblivion Code',
    bio: 'OpenCode bridge for feature work and verify gates.',
    frameworkType: 'opencode',
    avatarSeed: 'oblivion-opencode',
    defaultCallbackUrl: 'http://127.0.0.1:2103/admin/api/webhooks/party-quest',
    budgetUsd: 60,
  },
] as const;

export const seedOblivionRuntimeAgents = mutation({
  args: {
    sessionToken: v.optional(v.string()),
    partyId: v.optional(v.id('parties')),
    phantasyCallbackUrl: v.optional(v.string()),
    hermesCallbackUrl: v.optional(v.string()),
    openclawCallbackUrl: v.optional(v.string()),
    opencodeCallbackUrl: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = args.sessionToken ? await requireAuth(ctx, args.sessionToken) : null;
    const allowLocalUnauthedSeed =
      process.env.CONVEX_AGENT_MODE === 'anonymous' ||
      process.env.PARTY_QUEST_ALLOW_UNAUTH_DEMO_SEED === '1';
    if (!user && !allowLocalUnauthedSeed) {
      throw new Error('Pass a session token or enable PARTY_QUEST_ALLOW_UNAUTH_DEMO_SEED=1.');
    }

    let partyId = args.partyId;
    let ownerId = user?._id;

    if (user) {
      const membership = args.partyId
        ? await ctx.db
            .query('partyMembers')
            .withIndex('by_party_user', (q) =>
              q.eq('partyId', args.partyId!).eq('userId', user._id),
            )
            .unique()
        : await ctx.db
            .query('partyMembers')
            .withIndex('by_user', (q) => q.eq('userId', user._id))
            .first();
      if (!membership) {
        throw new Error('Create or join a party before seeding Oblivion runtime agents.');
      }
      partyId = membership.partyId;
    }

    if (!partyId) {
      const firstParty = await ctx.db.query('parties').first();
      partyId = firstParty?._id;
      ownerId = firstParty?.ownerId;
    } else if (!ownerId) {
      const party = await ctx.db.get(partyId);
      ownerId = party?.ownerId;
    }

    if (!partyId || !ownerId) {
      throw new Error('Create a party before seeding Oblivion runtime agents.');
    }

    const callbackOverrides: Record<string, string | undefined> = {
      'oblivion-phantasy-agent': args.phantasyCallbackUrl?.trim(),
      'oblivion-hermes-agent': args.hermesCallbackUrl?.trim(),
      'oblivion-openclaw-agent': args.openclawCallbackUrl?.trim(),
      'oblivion-opencode-agent': args.opencodeCallbackUrl?.trim(),
    };

    const now = Date.now();
    let squad = await ctx.db
      .query('squads')
      .withIndex('by_party_slug', (q) =>
        q.eq('partyId', partyId).eq('slug', 'oblivion-development'),
      )
      .first();

    if (!squad) {
      const squadId = await ctx.db.insert('squads', {
        partyId,
        name: 'Oblivion Development',
        slug: 'oblivion-development',
        description: 'Code, debug, marketing, and research squads for Oblivion.',
        createdAt: now,
        updatedAt: now,
      });
      squad = await ctx.db.get(squadId);
    }

    if (!squad) {
      throw new Error('Failed to create Oblivion development squad.');
    }

    const partyAgents = await ctx.db
      .query('agents')
      .withIndex('by_party', (q) => q.eq('partyId', partyId))
      .collect();

    const seededAgents: Array<{
      name: string;
      agentFrameworkId: string;
      frameworkType: string;
      agentId: string;
      callbackUrl: string;
      apiKey?: string;
      bootstrapToken: string;
      bootstrapExpiresAt: number;
      created: boolean;
    }> = [];

    for (const profile of OBLIVION_RUNTIME_AGENTS) {
      const callbackUrl =
        callbackOverrides[profile.agentFrameworkId] || profile.defaultCallbackUrl;

      const existingAgent = partyAgents.find(
        (candidate) => candidate.name === profile.name,
      );

      let agentId = existingAgent?._id;
      let created = false;

      const forgejoUsername = OBLIVION_FORGEJO_AGENT_USERNAMES[profile.agentFrameworkId];
      const sourceControlAccounts = forgejoUsername
        ? { forgejo: { username: forgejoUsername } }
        : undefined;

      if (!agentId) {
        agentId = await ctx.db.insert('agents', {
          partyId,
          name: profile.name,
          title: profile.title,
          bio: profile.bio,
          avatarSeed: profile.avatarSeed,
          frameworkType: profile.frameworkType,
          sourceControlAccounts,
          level: 1,
          xp: 0,
          isActive: true,
          createdAt: now,
          updatedAt: now,
        });
        created = true;
      } else {
        await ctx.db.patch(agentId, {
          title: profile.title,
          bio: profile.bio,
          frameworkType: profile.frameworkType,
          sourceControlAccounts,
          isActive: true,
          updatedAt: now,
        });
      }

      const existingCallback = await ctx.db
        .query('agentCallbacks')
        .withIndex('by_agent', (q) => q.eq('agentId', agentId))
        .first();

      if (existingCallback) {
        await ctx.db.patch(existingCallback._id, {
          callbackUrl,
          agentFrameworkId: profile.agentFrameworkId,
          frameworkType: profile.frameworkType,
          updatedAt: now,
        });
      } else {
        await ctx.db.insert('agentCallbacks', {
          agentId,
          callbackUrl,
          callbackSecret: generateFullApiKey(generateApiKeyPrefix()),
          agentFrameworkId: profile.agentFrameworkId,
          frameworkType: profile.frameworkType,
          createdAt: now,
          updatedAt: now,
        });
      }

      const existingMembership = await ctx.db
        .query('squadMembers')
        .withIndex('by_squad_agent', (q) =>
          q.eq('squadId', squad!._id).eq('agentId', agentId),
        )
        .first();
      if (!existingMembership) {
        await ctx.db.insert('squadMembers', {
          squadId: squad._id,
          agentId,
          joinedAt: now,
          updatedAt: now,
        });
      }

      let apiKey: string | undefined;
      const existingKey = await ctx.db
        .query('agentApiKeys')
        .withIndex('by_agent', (q) => q.eq('agentId', agentId))
        .first();
      if (!existingKey) {
        const keyPrefix = generateApiKeyPrefix();
        apiKey = generateFullApiKey(keyPrefix);
        await ctx.db.insert('agentApiKeys', {
          agentId,
          keyPrefix,
          keyHash: await hashApiKey(apiKey),
          createdAt: now,
        });
      }

      const { bootstrapToken, expiresAt } = await issueBootstrapTokenRecord(ctx, {
        agentId,
        partyId,
        createdBy: ownerId,
      });

      seededAgents.push({
        name: profile.name,
        agentFrameworkId: profile.agentFrameworkId,
        frameworkType: profile.frameworkType,
        agentId,
        callbackUrl,
        apiKey,
        bootstrapToken,
        bootstrapExpiresAt: expiresAt,
        created,
      });
    }

    return {
      partyId,
      squadId: squad._id,
      partyQuestUrl: process.env.PARTY_QUEST_PUBLIC_URL || 'https://party.phantasy.bot',
      agents: seededAgents,
    };
  },
});

export const seedOblivionDevelopment = mutation({
  args: {
    sessionToken: v.optional(v.string()),
    partyId: v.optional(v.id('parties')),
    repoUrl: v.optional(v.string()),
    repoOwner: v.optional(v.string()),
    repoName: v.optional(v.string()),
    defaultBranch: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = args.sessionToken ? await requireAuth(ctx, args.sessionToken) : null;
    const allowLocalUnauthedSeed =
      process.env.CONVEX_AGENT_MODE === 'anonymous' ||
      process.env.PARTY_QUEST_ALLOW_UNAUTH_DEMO_SEED === '1';
    if (!user && !allowLocalUnauthedSeed) {
      throw new Error('Pass a session token or enable local demo seeding explicitly.');
    }

    let partyId = args.partyId;
    let ownerId = user?._id;

    if (user) {
      const membership = args.partyId
        ? await ctx.db
            .query('partyMembers')
            .withIndex('by_party_user', (q) =>
              q.eq('partyId', args.partyId!).eq('userId', user._id),
            )
            .unique()
        : await ctx.db
            .query('partyMembers')
            .withIndex('by_user', (q) => q.eq('userId', user._id))
            .first();
      if (!membership) {
        throw new Error('Create or join a party before seeding Oblivion Development.');
      }
      partyId = membership.partyId;
    }

    if (!partyId) {
      const firstParty = await ctx.db.query('parties').first();
      partyId = firstParty?._id;
      ownerId = firstParty?.ownerId;
    } else if (!ownerId) {
      const party = await ctx.db.get(partyId);
      ownerId = party?.ownerId;
    }

    if (!partyId || !ownerId) {
      throw new Error('Create a party before seeding Oblivion Development.');
    }

    const now = Date.now();
    const repoOwner = args.repoOwner?.trim() || 'oblivion';
    const repoName = args.repoName?.trim() || 'oblivion';
    const defaultBranch = args.defaultBranch?.trim() || 'main';
    const repoUrl =
      args.repoUrl?.trim() || `https://forgejo.phantasy.bot/${repoOwner}/${repoName}`;

    const existing = await ctx.db
      .query('campaigns')
      .withIndex('by_party_slug', (q) =>
        q.eq('partyId', partyId).eq('slug', 'oblivion-development'),
      )
      .first();

    let campaignId = existing?._id;
    let objectiveId = existing?.objectiveId;

    if (!campaignId || !objectiveId) {
      objectiveId = await ctx.db.insert('objectives', {
        partyId,
        ownerUserId: ownerId,
        title: 'Oblivion Product Development',
        description: 'Build and maintain Oblivion on Forgejo with general-purpose agent squads.',
        kind: 'campaign_objective',
        status: 'active',
        priority: 'high',
        createdAt: now,
        updatedAt: now,
      });

      campaignId = await ctx.db.insert('campaigns', {
        partyId,
        objectiveId,
        createdBy: ownerId,
        title: 'Oblivion Development',
        slug: 'oblivion-development',
        description: 'Code, debug, marketing, and research squads for Oblivion.',
        repoProvider: 'forgejo',
        repoOwner,
        repoName,
        defaultBranch,
        repoUrl,
        status: 'active',
        priority: 'high',
        createdAt: now,
        updatedAt: now,
      });
    }

    const squadSpecs = [
      { slug: 'code', name: 'Code', description: 'Features, tests, PRs, npm run verify.' },
      { slug: 'debug', name: 'Debug', description: 'CI failures, flakes, incident triage.' },
      {
        slug: 'marketing',
        name: 'Marketing',
        description: 'Docs, trust-center, copy, business channels.',
      },
      {
        slug: 'research',
        name: 'Research',
        description: 'Broker landscape, policy, competitive research.',
      },
    ] as const;

    const squadIds = new Map<string, Id<'squads'>>();
    for (const spec of squadSpecs) {
      const existingSquad = await ctx.db
        .query('squads')
        .withIndex('by_party_slug', (q) =>
          q.eq('partyId', partyId).eq('slug', spec.slug),
        )
        .first();
      if (existingSquad) {
        squadIds.set(spec.slug, existingSquad._id);
        continue;
      }
      const squadId = await ctx.db.insert('squads', {
        partyId,
        name: spec.name,
        slug: spec.slug,
        description: spec.description,
        createdAt: now,
        updatedAt: now,
      });
      squadIds.set(spec.slug, squadId);
    }

    const OBLIVION_SQUAD_AGENT_MAP = {
      code: { agentFrameworkId: 'oblivion-opencode-agent', frameworkType: 'opencode' },
      debug: { agentFrameworkId: 'oblivion-openclaw-agent', frameworkType: 'openclaw' },
      marketing: { agentFrameworkId: 'oblivion-phantasy-agent', frameworkType: 'phantasy' },
      research: { agentFrameworkId: 'oblivion-hermes-agent', frameworkType: 'hermes' },
    } as const;

    const resolveAgentByFrameworkId = async (agentFrameworkId: string) => {
      const callback = await ctx.db
        .query('agentCallbacks')
        .withIndex('by_framework_id', (q) => q.eq('agentFrameworkId', agentFrameworkId))
        .first();
      if (!callback) return null;
      const agent = await ctx.db.get(callback.agentId);
      if (!agent || agent.partyId !== partyId) return null;
      return agent;
    };

    let wiredSquadMembers = 0;
    for (const [squadSlug, mapping] of Object.entries(OBLIVION_SQUAD_AGENT_MAP)) {
      const squadId = squadIds.get(squadSlug);
      const agent = await resolveAgentByFrameworkId(mapping.agentFrameworkId);
      if (!squadId || !agent) continue;

      const existingMembership = await ctx.db
        .query('squadMembers')
        .withIndex('by_squad_agent', (q) =>
          q.eq('squadId', squadId).eq('agentId', agent._id),
        )
        .first();
      if (!existingMembership) {
        await ctx.db.insert('squadMembers', {
          squadId,
          agentId: agent._id,
          joinedAt: now,
          updatedAt: now,
        });
        wiredSquadMembers += 1;
      }

      await ctx.db.patch(agent._id, {
        frameworkType: mapping.frameworkType,
        updatedAt: now,
      });
    }

    const questSpecs = [
      {
        title: 'Daily verify on main',
        squad: 'code',
        agentFrameworkId: 'oblivion-opencode-agent',
        frameworkType: 'opencode' as const,
        priority: 'normal' as const,
        execution: { kind: 'workflow', workflowPath: 'npm run verify' },
        sourceRef: {
          provider: 'forgejo' as const,
          kind: 'repository' as const,
          repoOwner,
          repoName,
          branch: defaultBranch,
        },
      },
      {
        title: 'Weekly docs verify',
        squad: 'marketing',
        agentFrameworkId: 'oblivion-phantasy-agent',
        frameworkType: 'phantasy' as const,
        priority: 'normal' as const,
        execution: { kind: 'workflow', workflowPath: 'npm run docs:verify' },
        sourceRef: {
          provider: 'forgejo' as const,
          kind: 'repository' as const,
          repoOwner,
          repoName,
          branch: defaultBranch,
        },
      },
      {
        title: 'GitHub contribution triage',
        squad: 'debug',
        agentFrameworkId: 'oblivion-openclaw-agent',
        frameworkType: 'openclaw' as const,
        priority: 'high' as const,
        sourceRef: {
          provider: 'github' as const,
          kind: 'repository' as const,
          repoOwner: 'thomasjvu',
          repoName: 'oblivion',
        },
      },
      {
        title: 'Forgejo CI failure response',
        squad: 'debug',
        agentFrameworkId: 'oblivion-openclaw-agent',
        frameworkType: 'openclaw' as const,
        priority: 'high' as const,
        sourceRef: {
          provider: 'forgejo' as const,
          kind: 'repository' as const,
          repoOwner,
          repoName,
          branch: defaultBranch,
        },
      },
      {
        title: 'Broker catalog policy review',
        squad: 'research',
        agentFrameworkId: 'oblivion-hermes-agent',
        frameworkType: 'hermes' as const,
        priority: 'normal' as const,
        execution: {
          kind: 'workflow',
          workflowPath: 'npm test -- --test-name-pattern=broker',
        },
        sourceRef: {
          provider: 'forgejo' as const,
          kind: 'repository' as const,
          repoOwner,
          repoName,
          branch: defaultBranch,
        },
      },
      {
        title: 'Trust-center version sync',
        squad: 'marketing',
        agentFrameworkId: 'oblivion-phantasy-agent',
        frameworkType: 'phantasy' as const,
        priority: 'normal' as const,
        execution: { kind: 'workflow', workflowPath: 'npm run version:sync' },
        sourceRef: {
          provider: 'forgejo' as const,
          kind: 'repository' as const,
          repoOwner,
          repoName,
          branch: defaultBranch,
        },
      },
    ];

    const existingQuests = await ctx.db
      .query('quests')
      .withIndex('by_campaign', (q) => q.eq('campaignId', campaignId!))
      .collect();

    let createdQuests = 0;
    let updatedQuests = 0;
    for (const [index, spec] of questSpecs.entries()) {
      const assignedAgent = await resolveAgentByFrameworkId(spec.agentFrameworkId);
      const squadId = squadIds.get(spec.squad);
      const existingQuest = existingQuests.find((quest) => quest.title === spec.title);

      if (existingQuest) {
        await ctx.db.patch(existingQuest._id, {
          squadId,
          assignedAgentId: assignedAgent?._id,
          requestedFrameworkType: spec.frameworkType,
          execution: spec.execution,
          autonomyMode: 'hybrid',
          priority: spec.priority,
          status: 'ready',
          claimedByAgentId: undefined,
          activeRunId: undefined,
          checkoutRunId: undefined,
          leaseExpiresAt: undefined,
          workspaceLockExpiresAt: undefined,
          nextClaimAt: undefined,
          updatedAt: now + index,
        });
        updatedQuests += 1;
        continue;
      }

      await ctx.db.insert('quests', {
        partyId,
        campaignId: campaignId!,
        squadId,
        createdBy: ownerId,
        assignedAgentId: assignedAgent?._id,
        title: spec.title,
        description: `Oblivion development lane: ${spec.title}`,
        type: 'task',
        autonomyMode: 'hybrid',
        status: 'ready',
        priority: spec.priority,
        requestedFrameworkType: spec.frameworkType,
        execution: spec.execution,
        sourceRef: spec.sourceRef,
        retryCount: 0,
        createdAt: now + index,
        updatedAt: now + index,
      });
      createdQuests += 1;
    }

    return {
      created: !existing,
      partyId,
      campaignId,
      squadCount: squadIds.size,
      wiredSquadMembers,
      createdQuests,
      updatedQuests,
      repoUrl,
    };
  },
});