# Agent Note: Ops workspace and shared SSH service

Status: implemented

## Problem

Test-environment operations need saved system, service and server relationships, reusable scripts and visible execution records. The SSH plugin already owns authentication, host entries and connection pooling. A sibling operations plugin needs those capabilities through a shared contract so both interfaces operate on the same repository.

## Decision

`dsh-ops` owns the system/service/server/task definitions, script and flow runner, schedules, notifications, and per-target run logs. The Host and browser halves mount through its package entry and `./client`, and the aggregate includes it after `dsh-ssh`.

`dsh-ssh` publishes `sshTransport` as a Cordis service. The operations plugin declares a structural contract and injects the service. The service forwards host CRUD, OpenSSH config import, file transfers, connectivity checks and command execution to the existing store and engine. The OpenSSH importer is the same implementation used by the SSH page.

Script execution passes source through stdin and streams output to the operations run store. This path attempts execution once to avoid replaying a command after a broken connection. Existing buffered SSH execution keeps its connection retry behavior. The operations master switch controls its scheduler as well as routes and tools, and agent announcements default to disabled.

## Alternatives considered

Importing the SSH engine directly into the operations plugin couples its build graph to another plugin's internals and creates a second owner for connection lifetime. The shared service keeps one engine owned by SSH.

Running every workflow step through model-issued SSH tool calls leaves execution order and progress dependent on an agent session. The operations runner executes the saved task definitions and exposes submission and query tools to the agent.

## Consequences

Credentials stay in the SSH store and summaries carry no credentials. The operations routes use the family's loopback request checks. Remote browser deployment supplies its own authenticated access layer.

Run records survive Host shutdown, while the in-process runner and locks do not. Persisted running records require operator verification after restart. Flows reference script tasks and support ordered steps and adjacent parallel batches, and multi-target script runs execute serially.

The shared-service import regression test uses an isolated OpenSSH config. The Host entry test verifies that a disabled operations entry creates no scheduled run. Package metadata and the locale audit include the operations plugin.
