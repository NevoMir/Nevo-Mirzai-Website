# Identifiability in Inverse Reinforcement Learning

2025 — Brief project summary: understanding when we can reliably recover an agent’s goals from how it behaves.



Inverse Reinforcement Learning (IRL) is about guessing what an agent “wants” (its reward function) by watching how it behaves in an environment. Instead of telling the agent what to optimize, we observe an expert (for example, a human driver or a skilled robot) and try to infer the hidden objective that makes their behavior look optimal.

The central difficulty is *identifiability*: in many situations, very different reward functions can produce exactly the same behavior. When that happens, IRL cannot tell which reward is the “true” one, which makes generalization and safety hard: a model that behaves well in the training environment might act in an unexpected way in new situations.

This project studies when IRL **can** uniquely recover a reward (up to an irrelevant constant shift) and when it cannot. We look at three recent theoretical advances that:

- connect identifiability to graph properties of the Markov Decision Process,
- extend the analysis to entropy-regularized (maximum-entropy) policies in both finite and infinite horizons,
- and show how having **multiple experts** or multiple environments can break ambiguities and make the reward identifiable, or at least generalizable to new settings.

Building on this prior work, our report provides a unified, high-level overview of these ideas and then adds an extra piece: we derive an explicit bound that quantifies how **errors in the estimated dynamics** (transition probabilities) affect the recovered reward. In simple terms, we ask: *if our model of the environment is slightly wrong, how far off can our inferred reward be?* We give a mathematical inequality that links the size of the transition error to the maximum possible error on the learned reward.

Overall, the project clarifies:

- why IRL is inherently ambiguous in general,
- what structural conditions (on dynamics, policies, and environments) are needed to remove that ambiguity,
- and how robust the recovered reward is when the environment has to be learned from data.

This helps bridge the gap between elegant theory and practical IRL, where we almost never know the true dynamics perfectly but still want interpretable, reliable rewards to guide decision-making in real systems.
