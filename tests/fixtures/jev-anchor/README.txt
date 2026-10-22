The anchor import tests build their replay files at run time: a turn's state hash is a function of the seeded chat turns,
so a checked-in JSONL could not stay byte-identical to the rebuilt state. This directory holds the static route-key cases.
