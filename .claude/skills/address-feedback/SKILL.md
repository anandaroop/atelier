---
name: address-feedback
description: Selectively address feedback from a PR review, and create new tasks for any feedback that is not addressed
---

# Address PR Feedback

## Get the feedback

- Look at the currently open PR

- Examine feedback, whether from another Claude instance, or from me

## Handle the feedback

- **NOTE**: When deciding what to address, consider this: the other Claude reviewer instance knows the diff but not necessarily the whole project

- Apply fixes for critical or high-value items. Use your judgement for the rest.

- It may be ok to ignore low-value/edge cases, unless they reveal security vulnerabilities, in which case you must fix them

- If the feedback pertains to something already described by an upcoming task in the Github Project, add a comment to the relevant card so that it is available to us when we get to that task

- If the feedback warrants a new task, create a new card under the relevant epic. If no epic is relevant created an un-parented card.
