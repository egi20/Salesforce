'use strict';

/**
 * The challenge question bank, by topic. DATA ONLY — the rules that keep it off the
 * browser live in `config/challenges.js`, which is the only module that reads this file
 * (a test pins that).
 *
 * `answer` is an index into `options` and is NEVER serialised to a client before an
 * attempt is closed. `explain` is shown after grading and names the right option in prose,
 * so it is as secret as `answer` until then.
 *
 * Writing a question: one option must be right in every reading, the other three plainly
 * wrong to somebody who knows. A question with two defensible answers marks a correct
 * player wrong, and nobody can appeal to a bank they cannot see. Two of the first twenty
 * did exactly that and are corrected here:
 *
 *   - `gov-soql-101` marked "50" as the synchronous SOQL limit. It is 100 (the explanation
 *     already said so); every player who knew the limit was scored wrong on it.
 *   - `sandbox-refresh` asked which sandbox refreshes "most frequently" with Developer and
 *     Developer Pro both refreshing daily. Replaced by `sandbox-full-refresh`.
 *
 * Limits quoted here are the documented per-transaction governor limits and platform
 * limits; when Salesforce changes one, change the question in the same commit.
 */

const TOPIC_QUESTIONS = Object.freeze({
  'admin-security': [
    {
      id: 'sharing-owd',
      module: 'security',
      prompt: 'Which setting determines the baseline access a user has to records they do not own?',
      options: ['Profile', 'Permission set', 'Organisation-wide defaults', 'Role hierarchy'],
      answer: 2,
      explain: 'Organisation-wide defaults set the floor. Role hierarchy, sharing rules and manual sharing only ever open access up from there — they never restrict it.'
    },
    {
      id: 'field-history',
      module: 'platform',
      prompt: 'How many fields per object can be tracked with standard field history tracking?',
      options: ['10', '20', '25', '40'],
      answer: 1,
      explain: '20 fields per object, retained 18–24 months unless Field Audit Trail is licensed. It is the limit most data-migration plans discover late.'
    },
    {
      id: 'sandbox-full-refresh',
      module: 'devops',
      prompt: 'How often can a Full Copy sandbox be refreshed?',
      options: ['Once a day', 'Every 5 days', 'Every 29 days', 'Every 90 days'],
      answer: 2,
      explain: 'Full Copy: every 29 days. Partial Copy: every 5 days. Developer and Developer Pro: once a day.'
    },
    {
      id: 'sandbox-partial-template',
      module: 'devops',
      prompt: 'Which sandbox type copies a sample of production data chosen by a sandbox template?',
      options: ['Developer', 'Developer Pro', 'Partial Copy', 'Scratch org'],
      answer: 2,
      explain: 'A Partial Copy sandbox takes metadata plus a sample of records defined by a sandbox template. Developer and Developer Pro copy metadata only; a scratch org is not a sandbox.'
    },
    {
      id: 'one-profile',
      module: 'security',
      prompt: 'How many profiles can one user have?',
      options: ['Exactly one', 'Up to two', 'Up to ten', 'Any number'],
      answer: 0,
      explain: 'Exactly one profile per user. Anything more is added with permission sets and permission set groups, which is why least-privilege designs keep the profile minimal.'
    },
    {
      id: 'permission-set-group',
      module: 'security',
      prompt: 'What does a permission set group let an admin do?',
      options: [
        'Bundle several permission sets and assign them as one',
        'Give a user a second profile',
        'Override organisation-wide defaults for a group of users',
        'Share records with a public group'
      ],
      answer: 0,
      explain: 'A permission set group bundles permission sets for a job role. A muting permission set inside the group can switch off individual permissions the bundle would otherwise grant.'
    },
    {
      id: 'role-hierarchy-access',
      module: 'security',
      prompt: 'With "Grant Access Using Hierarchies" on, what does the role hierarchy give a manager?',
      options: [
        'Access to records owned by users below them in the hierarchy',
        'Access to records owned by users above them',
        'Edit access to every record of every object',
        'The ability to change subordinates’ profiles'
      ],
      answer: 0,
      explain: 'Access rolls UP the hierarchy: a manager sees what their subordinates own. It never gives a subordinate access to the manager’s records.'
    },
    {
      id: 'sharing-rule-basis',
      module: 'security',
      prompt: 'A sharing rule can be based on which of these?',
      options: [
        'Who owns the record, or field values on the record',
        'The user’s login IP address',
        'The page layout assigned to the record',
        'The time of day'
      ],
      answer: 0,
      explain: 'Owner-based sharing rules share records owned by a group or role; criteria-based sharing rules share records whose field values match. Both only open access beyond the default.'
    },
    {
      id: 'fls-where',
      module: 'security',
      prompt: 'Where is field-level security granted?',
      options: ['Page layouts', 'Profiles and permission sets', 'Record types', 'Sharing rules'],
      answer: 1,
      explain: 'Field-level security lives on profiles and permission sets. Sharing decides WHICH records; field-level security decides which FIELDS on them.'
    },
    {
      id: 'layout-not-security',
      module: 'security',
      prompt: 'An admin removes a field from every page layout. What changes for API access to that field?',
      options: [
        'Nothing — layouts are not security; field-level security still decides',
        'The field becomes read-only through the API',
        'The field is hidden from the API and reports',
        'The field is encrypted at rest'
      ],
      answer: 0,
      explain: 'A page layout only arranges the record page. A user whose field-level security allows the field can still read it through the API, reports and list views.'
    },
    {
      id: 'trusted-ip-ranges',
      module: 'security',
      prompt: 'What do the organisation’s Trusted IP Ranges (Network Access) do?',
      options: [
        'Block every login from outside the ranges',
        'Let users log in from those addresses without being asked to verify their identity',
        'Restrict API calls to those addresses only',
        'Allow guest users to see internal records'
      ],
      answer: 1,
      explain: 'Trusted IP ranges skip the identity-verification challenge; they do not block anything. To refuse logins from elsewhere, set Login IP Ranges on the profile.'
    },
    {
      id: 'change-set-orgs',
      module: 'devops',
      prompt: 'Between which orgs can change sets be deployed?',
      options: [
        'Any two Salesforce orgs',
        'Orgs affiliated with the same production org, connected by a deployment connection',
        'Only scratch orgs',
        'Only Developer Edition orgs'
      ],
      answer: 1,
      explain: 'Change sets move metadata between a production org and its sandboxes (or between those sandboxes), and only along an authorised deployment connection.'
    },
    {
      id: 'validation-true-blocks',
      module: 'platform',
      prompt: 'A validation rule blocks the save when its formula returns what?',
      options: ['TRUE', 'FALSE', 'NULL', 'An error message text'],
      answer: 0,
      explain: 'The formula describes the INVALID state: TRUE means "this record is wrong", and the save is refused with the rule’s message.'
    },
    {
      id: 'record-types-control',
      module: 'platform',
      prompt: 'What do record types primarily control?',
      options: [
        'Which records a user can see',
        'Which picklist values and page layout a user gets for a record',
        'Field-level security',
        'The record’s owner'
      ],
      answer: 1,
      explain: 'Record types offer different business processes, picklist values and page layouts. They are not a security control; sharing still decides visibility.'
    },
    {
      id: 'delegated-admin',
      module: 'security',
      prompt: 'What does delegated administration allow?',
      options: [
        'Named users manage users in specified roles and profiles without full admin rights',
        'Any user can create custom objects',
        'A partner org administers your org',
        'Admins log in without multi-factor authentication'
      ],
      answer: 0,
      explain: 'A delegated administration group lets, say, a regional manager reset passwords and assign permission sets for their own users without System Administrator.'
    },
    {
      id: 'view-all-data',
      module: 'security',
      prompt: 'Which permission lets a user read every record in the org regardless of sharing?',
      options: ['View All Data', 'API Enabled', 'View Setup and Configuration', 'Customize Application'],
      answer: 0,
      explain: 'View All Data bypasses sharing for reading every object. It is the permission an access review should look for first.'
    },
    {
      id: 'guest-sharing-rules',
      module: 'experience-cloud',
      prompt: 'How are records shared with the unauthenticated guest user of a site?',
      options: [
        'Through guest user sharing rules',
        'By putting the guest user in the role hierarchy',
        'By making the guest user a record owner',
        'Through manual sharing from the record'
      ],
      answer: 0,
      explain: 'Guest users get record access only through guest user sharing rules (criteria-based). They cannot be in the role hierarchy or own records, which keeps public exposure explicit.'
    },
    {
      id: 'queue-owner',
      module: 'platform',
      prompt: 'Besides a user, what can own a record such as a lead or case?',
      options: ['A queue', 'A role', 'A permission set', 'A profile'],
      answer: 0,
      explain: 'A queue can own records of the objects it supports; its members pick work from it. Roles, profiles and permission sets never own records.'
    },
    {
      id: 'public-group-members',
      module: 'security',
      prompt: 'What can a public group contain?',
      options: [
        'Users, roles, roles and subordinates, and other groups',
        'Only users',
        'Only profiles',
        'Only permission sets'
      ],
      answer: 0,
      explain: 'Public groups gather users, roles (with or without subordinates) and other groups, so one sharing rule can target all of them.'
    },
    {
      id: 'setup-audit-trail',
      module: 'security',
      prompt: 'Where would an admin see who changed a validation rule last week?',
      options: ['Setup Audit Trail', 'Login History', 'Field History Tracking', 'Debug logs'],
      answer: 0,
      explain: 'Setup Audit Trail records configuration changes and who made them, for the last 180 days. Field history tracks data changes, not setup.'
    },
    {
      id: 'external-owd',
      module: 'security',
      prompt: 'How must an object’s default external access compare with its default internal access?',
      options: [
        'Equal to or more restrictive',
        'Equal to or more permissive',
        'Always Public Read Only',
        'Always the same'
      ],
      answer: 0,
      explain: 'External organisation-wide defaults can never be more open than the internal ones, so external users never see more than employees by default.'
    },
    {
      id: 'master-detail-sharing',
      module: 'platform',
      prompt: 'In a master-detail relationship, what decides who can see a detail record?',
      options: [
        'The master record — sharing is "Controlled by Parent"',
        'The detail record’s own owner',
        'A separate sharing rule on the detail object',
        'The detail object’s page layout'
      ],
      answer: 0,
      explain: 'Detail records have no owner of their own; access follows the master. That is the practical difference from a lookup when designing security.'
    }
  ],

  'apex-lwc': [
    {
      id: 'gov-soql-101',
      module: 'apex',
      prompt: 'What is the synchronous Apex governor limit on SOQL queries per transaction?',
      options: ['50', '100', '150', '200'],
      answer: 1,
      explain: 'Synchronous Apex allows 100 SOQL queries; asynchronous allows 200. The figure people mix it up with is 150, the DML statement limit.'
    },
    {
      id: 'gov-dml-101',
      module: 'apex',
      prompt: 'How many DML statements may a single Apex transaction issue?',
      options: ['100', '150', '200', '50'],
      answer: 1,
      explain: '150 DML statements per transaction. This is why bulkification matters: one statement over a collection, never one per record in a loop.'
    },
    {
      id: 'deploy-coverage',
      module: 'apex',
      prompt: 'What Apex code coverage does a production deployment require?',
      options: ['60%', '70%', '75%', '80%'],
      answer: 2,
      explain: '75% org-wide, and every trigger must have some coverage. Coverage is a deployment gate, not a measure of test quality.'
    },
    {
      id: 'with-sharing',
      module: 'security',
      prompt: 'An Apex class declared "without sharing" does what?',
      options: [
        'Ignores the running user’s sharing rules',
        'Ignores field-level security as well',
        'Runs as the Automated Process user',
        'Refuses to compile outside a managed package'
      ],
      answer: 0,
      explain: 'It ignores sharing rules, but NOT field-level security or object permissions — those need explicit checks such as Security.stripInaccessible or a query in user mode.'
    },
    {
      id: 'lwc-wire',
      module: 'lightning',
      prompt: 'What does the @wire decorator in a Lightning Web Component do?',
      options: [
        'Registers an event listener on the DOM',
        'Reads Salesforce data reactively through the Lightning Data Service or an Apex method',
        'Declares a public property settable from the parent',
        'Imports a static resource'
      ],
      answer: 1,
      explain: '@wire is the reactive read. @api declares a public property; @track is now only needed for mutating the internals of objects and arrays.'
    },
    {
      id: 'gov-heap-sync',
      module: 'apex',
      prompt: 'What is the synchronous Apex heap size limit?',
      options: ['3 MB', '6 MB', '12 MB', '24 MB'],
      answer: 1,
      explain: '6 MB synchronous, 12 MB asynchronous. Large query results held in a collection are the usual way to hit it.'
    },
    {
      id: 'gov-cpu-sync',
      module: 'apex',
      prompt: 'What is the maximum CPU time for a synchronous Apex transaction?',
      options: ['1,000 ms', '5,000 ms', '10,000 ms', '60,000 ms'],
      answer: 2,
      explain: '10,000 ms synchronous and 60,000 ms asynchronous. Time spent waiting on the database or a callout does not count towards it.'
    },
    {
      id: 'gov-soql-rows',
      module: 'apex',
      prompt: 'How many records can SOQL queries retrieve in total in one transaction?',
      options: ['10,000', '50,000', '100,000', '1,000,000'],
      answer: 1,
      explain: '50,000 rows across all queries in the transaction. Batch Apex with a QueryLocator is the way to work over more.'
    },
    {
      id: 'gov-dml-rows',
      module: 'apex',
      prompt: 'How many records can DML statements process in total in one transaction?',
      options: ['2,000', '10,000', '50,000', '100,000'],
      answer: 1,
      explain: '10,000 records processed by DML per transaction, separate from the 150-statement limit.'
    },
    {
      id: 'gov-callouts',
      module: 'integration',
      prompt: 'How many HTTP callouts can one Apex transaction make?',
      options: ['10', '50', '100', '150'],
      answer: 2,
      explain: '100 callouts per transaction, with a cumulative timeout of 120 seconds across them.'
    },
    {
      id: 'future-signature',
      module: 'apex',
      prompt: 'Which is required of an @future method?',
      options: [
        'It must be static and return void',
        'It must return a Boolean',
        'It must accept an sObject parameter',
        'It must be declared in a trigger'
      ],
      answer: 0,
      explain: '@future methods are static, return void and take only primitives or collections of primitives — pass Ids and query again inside the method.'
    },
    {
      id: 'queueable-vs-future',
      module: 'apex',
      prompt: 'What can a Queueable job do that an @future method cannot?',
      options: [
        'Run synchronously',
        'Take non-primitive parameters and chain another job',
        'Skip governor limits',
        'Run without a user context'
      ],
      answer: 1,
      explain: 'A Queueable accepts sObjects and other complex types, returns a job Id you can monitor, and can enqueue a follow-up job.'
    },
    {
      id: 'batch-default-scope',
      module: 'apex',
      prompt: 'What batch size does Database.executeBatch use when none is given?',
      options: ['100', '200', '500', '2,000'],
      answer: 1,
      explain: '200 records per execute() call by default; you can pass a scope of up to 2,000. Each execute() gets its own governor limits.'
    },
    {
      id: 'test-data-isolation',
      module: 'apex',
      prompt: 'By default, can an Apex test read the org’s existing records?',
      options: [
        'Yes, all of them',
        'No — only data the test creates, apart from setup objects such as users',
        'Only records owned by the running user',
        'Only in a sandbox'
      ],
      answer: 1,
      explain: 'Tests are isolated from org data unless annotated @IsTest(SeeAllData=true), which is best avoided: a test that depends on existing data breaks when the data changes.'
    },
    {
      id: 'test-start-stop',
      module: 'apex',
      prompt: 'What do Test.startTest() and Test.stopTest() do?',
      options: [
        'Mark which tests count towards coverage',
        'Give the code between them a fresh set of limits, and run queued asynchronous work at stopTest',
        'Roll back the database between the two calls',
        'Switch the test to run as another user'
      ],
      answer: 1,
      explain: 'Code between the two calls gets its own governor limits, and asynchronous Apex enqueued there (future, queueable, batch) completes at stopTest so the test can assert on it.'
    },
    {
      id: 'trigger-old',
      module: 'apex',
      prompt: 'In an update trigger, which context variable holds the field values from before the change?',
      options: ['Trigger.new', 'Trigger.old', 'Trigger.size', 'Trigger.isExecuting'],
      answer: 1,
      explain: 'Trigger.old (and Trigger.oldMap) hold the previous values; Trigger.new holds the incoming ones. Comparing the two is how a trigger acts only when a field actually changed.'
    },
    {
      id: 'trigger-after-readonly',
      module: 'apex',
      prompt: 'Can you change field values on Trigger.new in an after trigger?',
      options: [
        'Yes, and they are saved automatically',
        'No — the records are read-only there; set fields in a before trigger instead',
        'Only for custom objects',
        'Only in an after insert, not an after update'
      ],
      answer: 1,
      explain: 'In after triggers Trigger.new is read-only. Setting a field on the record being saved belongs in a before trigger (or a before-save flow), which costs no extra DML.'
    },
    {
      id: 'lwc-api',
      module: 'lightning',
      prompt: 'What does @api do in a Lightning Web Component?',
      options: [
        'Makes a property or method public so a parent can set or call it',
        'Calls an Apex method',
        'Makes a property reactive to its internal changes',
        'Exposes the component to the REST API'
      ],
      answer: 0,
      explain: '@api marks the component’s public surface. A child should not mutate an @api property it was given; it tells the parent instead.'
    },
    {
      id: 'lwc-custom-event',
      module: 'lightning',
      prompt: 'How does a child Lightning Web Component tell its parent that something happened?',
      options: [
        'It dispatches a CustomEvent',
        'It writes to the parent’s @api property',
        'It calls a static resource',
        'It updates a custom setting'
      ],
      answer: 0,
      explain: 'Data flows down through properties and up through events: the child dispatches a CustomEvent and the parent listens with an on<eventname> handler.'
    },
    {
      id: 'lwc-wire-cacheable',
      module: 'lightning',
      prompt: 'An Apex method used with @wire must be annotated how?',
      options: ['@AuraEnabled(cacheable=true)', '@InvocableMethod', '@future', '@RemoteAction'],
      answer: 0,
      explain: 'Wired Apex must be @AuraEnabled(cacheable=true), which also means it may not perform DML. A method that changes data is called imperatively instead.'
    },
    {
      id: 'lwc-connected-callback',
      module: 'lightning',
      prompt: 'Which Lightning Web Component lifecycle hook runs when the component is inserted into the DOM?',
      options: ['constructor', 'connectedCallback', 'renderedCallback', 'disconnectedCallback'],
      answer: 1,
      explain: 'connectedCallback runs on insertion and is where initial data loading usually starts. renderedCallback runs after every render, so work there must guard against repeating.'
    },
    {
      id: 'soql-injection',
      module: 'security',
      prompt: 'What prevents SOQL injection in dynamic SOQL built from user input?',
      options: [
        'Bind variables (or escaping with String.escapeSingleQuotes)',
        'Declaring the class with sharing',
        'Running the query in a future method',
        'Using a LIMIT clause'
      ],
      answer: 0,
      explain: 'A bind variable is passed as a value and can never change the query’s structure. Sharing and LIMIT have nothing to do with injection.'
    },
    {
      id: 'soql-user-mode',
      module: 'security',
      prompt: 'What does WITH USER_MODE on a SOQL query enforce?',
      options: [
        'Only the running user’s sharing',
        'The running user’s sharing, object permissions and field-level security',
        'Nothing at runtime — it is a code-review hint',
        'System mode, ignoring every permission'
      ],
      answer: 1,
      explain: 'User mode applies sharing, CRUD and field-level security of the running user to the query, and throws if an inaccessible field is requested.'
    },
    {
      id: 'callout-after-dml',
      module: 'integration',
      prompt: 'What happens when Apex makes an HTTP callout after DML in the same transaction?',
      options: [
        'The DML is rolled back automatically',
        'It fails with "You have uncommitted work pending"',
        'The callout is queued until the transaction commits',
        'Nothing — it is allowed'
      ],
      answer: 1,
      explain: 'Callouts must come before DML in a transaction. The usual fix is to move the callout to asynchronous Apex after the save.'
    }
  ],

  'flow-automation': [
    {
      id: 'order-of-execution',
      module: 'apex',
      prompt: 'In the order of execution, when do custom validation rules run relative to Apex before triggers?',
      options: [
        'Before the before trigger',
        'After the before trigger',
        'After the after trigger',
        'Validation rules do not run on trigger-modified records'
      ],
      answer: 1,
      explain: 'Before-save flows and before triggers run first; custom validation rules run after them. A before trigger can therefore make a record fail validation.'
    },
    {
      id: 'flow-vs-trigger',
      module: 'automation',
      prompt: 'Which automation runs FIRST when a record is saved?',
      options: ['Record-triggered flow (after save)', 'Before-save flow', 'Apex before trigger', 'Workflow rule'],
      answer: 1,
      explain: 'Before-save flows run before Apex before triggers. They are also the cheapest way to set a field on the record being saved, because no extra DML is issued.'
    },
    {
      id: 'after-save-after-triggers',
      module: 'automation',
      prompt: 'Relative to Apex after triggers, when do after-save record-triggered flows run?',
      options: ['Before them', 'After them', 'At the same time', 'Only if no trigger exists'],
      answer: 1,
      explain: 'After triggers run first, then assignment, auto-response and escalation steps, then after-save record-triggered flows — all still inside the same transaction.'
    },
    {
      id: 'duplicate-rules-order',
      module: 'automation',
      prompt: 'When do duplicate rules run relative to custom validation rules?',
      options: ['Before them', 'After them', 'Only on insert, before triggers', 'They replace them'],
      answer: 1,
      explain: 'Custom validation rules run, then duplicate rules, then the record is saved (but not committed) and after triggers fire.'
    },
    {
      id: 'before-save-limits',
      module: 'automation',
      prompt: 'What can a before-save (fast field update) record-triggered flow NOT do?',
      options: [
        'Update fields on the record that triggered it',
        'Create, update or delete other records',
        'Use a Decision element',
        'Read the record’s field values'
      ],
      answer: 1,
      explain: 'A before-save flow only changes the triggering record, which is what makes it fast. Anything touching other records belongs in an after-save flow.'
    },
    {
      id: 'after-save-when',
      module: 'automation',
      prompt: 'Which job needs an after-save flow rather than a before-save one?',
      options: [
        'Defaulting a field on the record being saved',
        'Creating a related task that needs the new record’s Id',
        'Uppercasing a text field before save',
        'Copying one field to another on the same record'
      ],
      answer: 1,
      explain: 'The record has an Id only once it is saved, and touching related records needs after-save. Same-record field updates are cheaper before save.'
    },
    {
      id: 'scheduled-paths',
      module: 'automation',
      prompt: 'What does a scheduled path in a record-triggered flow do?',
      options: [
        'Runs part of the flow at a time relative to the trigger or a date on the record',
        'Runs the whole flow every night',
        'Retries a failed element on a schedule',
        'Delays the record save'
      ],
      answer: 0,
      explain: 'A scheduled path runs later — say, three days before a contract’s end date — and re-checks the entry conditions when it runs if configured to.'
    },
    {
      id: 'screen-flow-type',
      module: 'automation',
      prompt: 'Which type of flow can show screens to a user?',
      options: ['Screen flow', 'Autolaunched flow', 'Record-triggered flow', 'Platform event-triggered flow'],
      answer: 0,
      explain: 'Only screen flows have a user interface. The others run in the background with no screens.'
    },
    {
      id: 'autolaunched-start',
      module: 'automation',
      prompt: 'How is an autolaunched flow with no trigger started?',
      options: [
        'Only by saving a record',
        'By Apex, another flow, the REST API, or a button or action',
        'Only from the Flow Builder debug window',
        'Only on a schedule'
      ],
      answer: 1,
      explain: 'An autolaunched flow with no trigger runs when something calls it: Apex, a subflow element, the REST API, or a quick action.'
    },
    {
      id: 'workflow-retired',
      module: 'automation',
      prompt: 'What should a team do with its remaining workflow rules and Process Builder processes?',
      options: [
        'Keep building new ones in them',
        'Migrate them to Flow — Salesforce has ended support for both',
        'Convert them to validation rules',
        'Move them to approval processes'
      ],
      answer: 1,
      explain: 'Salesforce retired workflow rules and Process Builder in favour of Flow; the Migrate to Flow tool converts many of them.'
    },
    {
      id: 'flow-dml-in-loop',
      module: 'automation',
      prompt: 'Why should Create/Update Records elements sit outside a loop in a flow?',
      options: [
        'Flow does not allow them inside loops',
        'Each one runs per iteration and can exhaust the transaction’s DML limits',
        'Loops cannot read record variables',
        'They run asynchronously inside loops'
      ],
      answer: 1,
      explain: 'Flows share Apex governor limits. Build a collection inside the loop and write it once after the loop — the flow version of bulkification.'
    },
    {
      id: 'record-prior',
      module: 'automation',
      prompt: 'In a record-triggered flow, how do you read a field’s value from before the update?',
      options: ['$Record__Prior', '$Record.Old', 'Trigger.old', 'PRIORVALUE() only'],
      answer: 0,
      explain: '$Record__Prior holds the record as it was before the update; $Record holds it as it is being saved. Comparing them is how a flow reacts only to a real change.'
    },
    {
      id: 'fault-path',
      module: 'automation',
      prompt: 'What is a fault path in a flow?',
      options: [
        'A connector that runs when an element fails, so the error can be handled',
        'A path that runs when no Decision outcome matches',
        'A debug-only branch',
        'The path a flow takes when it is deactivated'
      ],
      answer: 0,
      explain: 'Without a fault path, an element failure ends the flow with an unhandled error email. With one, the flow can log, notify or show a message.'
    },
    {
      id: 'approval-locks',
      module: 'automation',
      prompt: 'What happens to a record while it is pending in an approval process?',
      options: [
        'It is locked, so only admins and the current approver can edit it',
        'It is deleted until approved',
        'Anyone can still edit it',
        'It is moved to a queue'
      ],
      answer: 0,
      explain: 'Submission locks the record by default so it cannot change under the approver. Final approval or rejection actions decide whether it stays locked.'
    },
    {
      id: 'platform-event-flow',
      module: 'automation',
      prompt: 'Which flow type runs when a platform event message is received?',
      options: ['Screen flow', 'Platform event-triggered flow', 'Schedule-triggered flow', 'Before-save flow'],
      answer: 1,
      explain: 'A platform event-triggered flow subscribes to an event and runs for each message, in its own transaction.'
    },
    {
      id: 'subflow-purpose',
      module: 'automation',
      prompt: 'Why call a subflow?',
      options: [
        'To reuse the same logic from several flows',
        'To skip governor limits',
        'To run the logic as another user',
        'To make the flow run asynchronously'
      ],
      answer: 0,
      explain: 'A subflow keeps shared logic in one place, so a fix happens once. It runs in the same transaction and shares its limits.'
    },
    {
      id: 'get-records-first',
      module: 'automation',
      prompt: 'A Get Records element set to "Only the first record" stores its result as what?',
      options: ['A single record variable', 'A collection of records', 'A text variable', 'A number of records found'],
      answer: 0,
      explain: 'One record variable. "All records" stores a collection — the setting decides which kind of variable the element can fill.'
    },
    {
      id: 'assignment-element',
      module: 'automation',
      prompt: 'What does the Assignment element do in a flow?',
      options: [
        'Sets or changes the values of flow variables',
        'Assigns a record to a new owner in the database',
        'Assigns a permission set',
        'Runs the case assignment rules'
      ],
      answer: 0,
      explain: 'Assignment works on variables only. Nothing reaches the database until an Update or Create Records element runs.'
    },
    {
      id: 'run-asynchronously-path',
      module: 'automation',
      prompt: 'What is the "Run Asynchronously" path of an after-save flow for?',
      options: [
        'Work that should run after the transaction commits, such as callouts to external systems',
        'Making the flow run before triggers',
        'Running the flow in system mode',
        'Repeating the flow every hour'
      ],
      answer: 0,
      explain: 'The asynchronous path runs after the save commits, so it can call external systems and its failure does not roll back the record.'
    },
    {
      id: 'rollup-summary',
      module: 'platform',
      prompt: 'Which declarative field totals child records onto a parent without any automation?',
      options: [
        'A roll-up summary field, on the master of a master-detail relationship',
        'A formula field on a lookup',
        'A cross-object validation rule',
        'A record type'
      ],
      answer: 0,
      explain: 'Roll-up summary fields (COUNT, SUM, MIN, MAX) need master-detail. Over a lookup, the total has to be maintained by a flow or Apex.'
    },
    {
      id: 'entry-conditions',
      module: 'automation',
      prompt: 'What does "Only when a record is updated to meet the condition requirements" do on a record-triggered flow?',
      options: [
        'Runs the flow only on the save that makes the conditions become true',
        'Runs the flow on every save while the conditions are true',
        'Runs the flow only on insert',
        'Skips validation rules'
      ],
      answer: 0,
      explain: 'It fires on the transition — false before, true now — so a flow does not repeat every time an already-matching record is edited.'
    }
  ],

  'data-integration': [
    {
      id: 'data-cloud-dmo',
      module: 'data-cloud',
      prompt: 'In Data Cloud, what is a Data Model Object?',
      options: [
        'A raw copy of an ingested source table',
        'The canonical, harmonised shape that sources are mapped into',
        'A calculated metric published to Tableau',
        'A permission construct for row-level access'
      ],
      answer: 1,
      explain: 'Sources land as Data Lake Objects and are mapped into Data Model Objects, which is where harmonisation and identity resolution happen.'
    },
    {
      id: 'data-cloud-dlo',
      module: 'data-cloud',
      prompt: 'In Data Cloud, where does ingested data land before it is mapped?',
      options: ['Data Lake Objects', 'Data Model Objects', 'Calculated insights', 'Segments'],
      answer: 0,
      explain: 'A data stream writes into a Data Lake Object in the source’s own shape; mapping then connects it to the Data Model Objects.'
    },
    {
      id: 'data-cloud-stream',
      module: 'data-cloud',
      prompt: 'What brings data from a source system into Data Cloud?',
      options: ['A data stream', 'A segment', 'An activation', 'A sharing rule'],
      answer: 0,
      explain: 'A data stream connects a source — a Salesforce org, cloud storage, an API — and ingests it on a schedule or in near real time.'
    },
    {
      id: 'identity-resolution',
      module: 'data-cloud',
      prompt: 'What does identity resolution produce in Data Cloud?',
      options: [
        'Unified profiles from source records that match and reconcile rules say are the same person',
        'A deduplicated copy of the CRM that replaces it',
        'Encrypted versions of personal fields',
        'A list of users allowed to log in'
      ],
      answer: 0,
      explain: 'Match rules decide which records are the same individual; reconciliation rules decide which value wins. The source records are not changed.'
    },
    {
      id: 'calculated-insights',
      module: 'data-cloud',
      prompt: 'What is a calculated insight in Data Cloud?',
      options: [
        'A metric defined over the data model, such as lifetime value',
        'An AI-written summary of a record',
        'A dashboard component',
        'A data quality score set by an admin'
      ],
      answer: 0,
      explain: 'Calculated insights are defined (often in SQL) over unified data — lifetime value, engagement scores — and can be used in segments and activations.'
    },
    {
      id: 'segment-activation',
      module: 'data-cloud',
      prompt: 'In Data Cloud, what does activating a segment do?',
      options: [
        'Publishes the audience to a target such as Marketing Cloud or an advertising platform',
        'Deletes the profiles in it',
        'Turns the segment into a report',
        'Assigns the profiles to a queue'
      ],
      answer: 0,
      explain: 'A segment defines an audience; an activation sends it, with chosen attributes, to a destination that will act on it.'
    },
    {
      id: 'mulesoft-api-led',
      module: 'mulesoft',
      prompt: 'In MuleSoft’s API-led connectivity, which layer talks directly to the source system?',
      options: ['Experience API', 'Process API', 'System API', 'Gateway policy'],
      answer: 2,
      explain: 'System APIs front the source systems. Process APIs orchestrate across them; Experience APIs shape the result for one consumer.'
    },
    {
      id: 'bulk-api-2',
      module: 'integration',
      prompt: 'What is the main practical difference between Bulk API 2.0 and Bulk API 1.0?',
      options: [
        'Bulk API 2.0 supports SOAP as well as REST',
        'Bulk API 2.0 manages batching for you — you upload the whole file',
        'Bulk API 2.0 has no record limit',
        'Bulk API 2.0 is synchronous'
      ],
      answer: 1,
      explain: 'In 2.0 you create a job, upload the data and Salesforce splits it into batches. In 1.0 you create and manage each batch yourself.'
    },
    {
      id: 'platform-event',
      module: 'integration',
      prompt: 'A platform event published with the "Publish Immediately" behaviour is delivered when?',
      options: [
        'Only after the transaction commits',
        'Immediately, whether or not the transaction later rolls back',
        'On the next scheduled batch run',
        'Only to subscribers inside the same org'
      ],
      answer: 1,
      explain: 'Publish Immediately delivers even if the transaction rolls back — which is the point when you need an audit signal, and a trap when you assumed the record was saved.'
    },
    {
      id: 'external-id-upsert',
      module: 'integration',
      prompt: 'Why does an integration commonly upsert on an External Id field?',
      options: [
        'It is faster than insert',
        'It lets the source system key records without knowing Salesforce Ids',
        'It bypasses validation rules',
        'It is required for Bulk API'
      ],
      answer: 1,
      explain: 'The external system keeps its own key. Upserting on an indexed External Id makes the load idempotent — re-running it updates rather than duplicating.'
    },
    {
      id: 'skinny-table',
      module: 'platform',
      prompt: 'Large data volumes: what is a skinny table?',
      options: [
        'A custom object with fewer than ten fields',
        'A Salesforce-created table joining frequently queried fields to avoid a join at read time',
        'An archived copy of deleted records',
        'A Data Cloud data lake object'
      ],
      answer: 1,
      explain: 'Salesforce Support creates skinny tables; they contain a subset of fields from the base and custom-field tables so reads avoid the join. They are not self-service.'
    },
    {
      id: 'change-data-capture',
      module: 'integration',
      prompt: 'What does Change Data Capture publish?',
      options: [
        'Change events for record creates, updates, deletes and undeletes',
        'A nightly CSV of changed records',
        'Setup changes made by admins',
        'Login events'
      ],
      answer: 0,
      explain: 'Change Data Capture streams record changes as events, so an external system stays in sync without polling.'
    },
    {
      id: 'pub-sub-api',
      module: 'integration',
      prompt: 'The Pub/Sub API for publishing and subscribing to events is built on what?',
      options: ['gRPC', 'SOAP', 'FTP', 'GraphQL subscriptions'],
      answer: 0,
      explain: 'Pub/Sub API uses gRPC with Avro-encoded payloads, giving one interface for platform events and change events.'
    },
    {
      id: 'composite-resource',
      module: 'integration',
      prompt: 'What does the REST API Composite resource let a client do?',
      options: [
        'Send a series of requests in one call, with later ones using results of earlier ones',
        'Query several orgs at once',
        'Bypass API limits entirely',
        'Upload files larger than the normal limit'
      ],
      answer: 0,
      explain: 'Composite runs up to 25 subrequests in one round trip and can reference an earlier response — create an account, then a contact on it — in a single call.'
    },
    {
      id: 'named-credential',
      module: 'integration',
      prompt: 'Why make an Apex callout through a Named Credential?',
      options: [
        'It holds the endpoint and authentication, so code stores no secrets',
        'It removes the callout governor limit',
        'It makes the callout synchronous',
        'It encrypts the response body'
      ],
      answer: 0,
      explain: 'Named Credentials (with External Credentials) keep the URL and auth in setup; code refers to callout:Name and never handles a password or token.'
    },
    {
      id: 'remote-site-setting',
      module: 'integration',
      prompt: 'Without a Named Credential, what must exist before Apex can call an external endpoint?',
      options: ['A Remote Site Setting for it', 'A connected app', 'A permission set group', 'A custom metadata type'],
      answer: 0,
      explain: 'Callouts to an endpoint not covered by a Named Credential are refused unless a Remote Site Setting allows it.'
    },
    {
      id: 'outbound-message',
      module: 'integration',
      prompt: 'What is an outbound message?',
      options: [
        'A SOAP message sent to an endpoint, retried until acknowledged',
        'An email to a customer',
        'A Chatter post',
        'A REST callout written in Apex'
      ],
      answer: 0,
      explain: 'Outbound messages send selected fields as SOAP and retry for up to 24 hours until the endpoint acknowledges. They are configured, not coded.'
    },
    {
      id: 'salesforce-connect',
      module: 'integration',
      prompt: 'How does Salesforce Connect show data from an external system?',
      options: [
        'As external objects, read from the source at the time they are viewed',
        'By copying it into custom objects every night',
        'As files attached to records',
        'Only through reports'
      ],
      answer: 0,
      explain: 'External objects map to an external data source (for example through OData) and query it live, so the data is never copied into the org.'
    },
    {
      id: 'import-wizard-limit',
      module: 'integration',
      prompt: 'Up to how many records can the Data Import Wizard load at a time?',
      options: ['5,000', '50,000', '500,000', '5,000,000'],
      answer: 1,
      explain: '50,000 records. Beyond that, Data Loader handles up to five million, and the Bulk API more.'
    },
    {
      id: 'ownership-skew',
      module: 'platform',
      prompt: 'What is ownership skew?',
      options: [
        'One user owning a very large number of records of one object — guidance says over 10,000',
        'Records spread evenly across owners',
        'Owners in different time zones',
        'A record owned by a queue'
      ],
      answer: 0,
      explain: 'Sharing recalculation and role changes get slow and lock-prone when one owner holds tens of thousands of records — a common result of a single integration user owning everything.'
    },
    {
      id: 'external-id-indexed',
      module: 'platform',
      prompt: 'What does marking a custom field as an External ID also do?',
      options: ['Indexes it', 'Encrypts it', 'Makes it required', 'Hides it from users'],
      answer: 0,
      explain: 'External ID fields are indexed, which makes them fast to match on in upserts and selective in queries.'
    },
    {
      id: 'big-objects',
      module: 'platform',
      prompt: 'What are big objects for?',
      options: [
        'Storing very large volumes of records, such as history or archives, queried through a defined index',
        'Storing large files and images',
        'Objects with more than 500 fields',
        'Temporary data during a transaction'
      ],
      answer: 0,
      explain: 'Big objects hold billions of records with consistent performance, but queries must follow the object’s index — they are for archive and history, not everyday CRM work.'
    }
  ],

  'agentforce-ai': [
    {
      id: 'agentforce-grounding',
      module: 'agentforce',
      prompt: 'What does "grounding" mean for an Agentforce agent?',
      options: [
        'Restricting it to a single Salesforce org',
        'Supplying it with retrieved org data so its answers refer to real records',
        'Disabling its ability to take actions',
        'Running it on Hyperforce rather than a pod'
      ],
      answer: 1,
      explain: 'Grounding supplies retrieved context — records, knowledge articles, Data Cloud segments — so the answer is about the customer in front of you rather than a plausible invention.'
    },
    {
      id: 'trust-layer',
      module: 'agentforce',
      prompt: 'What is the Einstein Trust Layer?',
      options: [
        'Protections around generative AI requests, such as data masking, zero data retention with model providers and toxicity detection',
        'A sharing setting for AI-generated records',
        'A licence that unlocks Agentforce',
        'A sandbox for testing prompts'
      ],
      answer: 0,
      explain: 'The Trust Layer sits between the org and the model: it grounds and masks the prompt, checks the response for toxicity and keeps an audit trail.'
    },
    {
      id: 'zero-retention',
      module: 'agentforce',
      prompt: 'Under the Trust Layer’s zero data retention, what happens to a prompt sent to a third-party model provider?',
      options: [
        'The provider neither stores it nor uses it to train its models',
        'It is stored for 30 days for quality review',
        'It is used to train a model for your org only',
        'It is published to the AppExchange'
      ],
      answer: 0,
      explain: 'Zero data retention is a contractual commitment with the model providers: prompts and responses are not kept or used for training once the response is returned.'
    },
    {
      id: 'data-masking',
      module: 'agentforce',
      prompt: 'Why does the Trust Layer mask sensitive data before a prompt leaves Salesforce?',
      options: [
        'So the model sees placeholders instead of the data, which is restored in the response',
        'To shorten the prompt',
        'To translate it',
        'To stop users reading their own records'
      ],
      answer: 0,
      explain: 'Detected personal data is replaced by placeholders before the call and put back when the response returns, so the model never receives it.'
    },
    {
      id: 'toxicity-detection',
      module: 'agentforce',
      prompt: 'What does toxicity detection in the Trust Layer check?',
      options: [
        'Prompts and responses for harmful or inappropriate content',
        'Code for security vulnerabilities',
        'Records for duplicate values',
        'Users for suspicious logins'
      ],
      answer: 0,
      explain: 'Content is scored for categories such as hate, violence and profanity, and the scores are recorded with the audit data.'
    },
    {
      id: 'ai-audit-data',
      module: 'agentforce',
      prompt: 'Where are the generative AI audit and feedback records kept?',
      options: ['In Data Cloud', 'In debug logs only', 'In Setup Audit Trail', 'They are not kept'],
      answer: 0,
      explain: 'Prompts, masked data, responses, toxicity scores and user feedback are stored in Data Cloud, where they can be reported on.'
    },
    {
      id: 'agent-topic',
      module: 'agentforce',
      prompt: 'In Agentforce, what is a topic?',
      options: [
        'A category of jobs the agent can do, with its instructions and the actions allowed for it',
        'A Chatter group the agent posts in',
        'A knowledge article category',
        'A field on the conversation record'
      ],
      answer: 0,
      explain: 'Topics scope the agent: a request is classified into a topic, and only that topic’s instructions and actions are in play.'
    },
    {
      id: 'agent-action',
      module: 'agentforce',
      prompt: 'What is an agent action?',
      options: [
        'Something the agent can do — run a flow, Apex, a prompt template or an API call',
        'A button on the record page',
        'A user’s reply in the conversation',
        'A scheduled job'
      ],
      answer: 0,
      explain: 'Actions are the agent’s abilities. Each is built from something the platform already runs, which is why its permissions still apply.'
    },
    {
      id: 'topic-instructions',
      module: 'agentforce',
      prompt: 'What are a topic’s instructions?',
      options: [
        'Natural-language guidance on how the agent should behave and decide within that topic',
        'Apex code the topic runs',
        'The order of the topic’s screens',
        'Validation rules on the agent'
      ],
      answer: 0,
      explain: 'Instructions guide reasoning (“always confirm the order number before…”). They influence the model; hard limits come from which actions and permissions it has.'
    },
    {
      id: 'reasoning-engine',
      module: 'agentforce',
      prompt: 'What does the Atlas Reasoning Engine do in Agentforce?',
      options: [
        'Plans which topic and actions to use for a request, and evaluates the results',
        'Stores the agent’s conversation history',
        'Translates the agent’s replies',
        'Generates the agent’s user licence'
      ],
      answer: 0,
      explain: 'The reasoning engine classifies the request, chooses actions, runs them and decides whether more steps are needed before answering.'
    },
    {
      id: 'prompt-builder',
      module: 'agentforce',
      prompt: 'What does Prompt Builder create?',
      options: [
        'Reusable prompt templates grounded with merge fields and data',
        'Page layouts for AI fields',
        'Training data for a custom model',
        'Chat transcripts'
      ],
      answer: 0,
      explain: 'A prompt template combines instructions with merge fields, related lists, flows or Apex, so the same well-tested prompt is used every time.'
    },
    {
      id: 'agent-user',
      module: 'agentforce',
      prompt: 'A customer-facing service agent runs as what?',
      options: [
        'A dedicated agent user, whose permissions bound what it can see and do',
        'The admin who built it',
        'The customer chatting with it',
        'No user — it bypasses permissions'
      ],
      answer: 0,
      explain: 'The agent user’s profile and permission sets decide what records and actions the agent can reach, so grant it the minimum.'
    },
    {
      id: 'agent-guardrail',
      module: 'agentforce',
      prompt: 'What is the most reliable way to make sure an agent can never issue a refund?',
      options: [
        'Do not give it an action that can issue one',
        'Tell it in the instructions never to refund',
        'Lower the model temperature',
        'Add the word “never” to the topic name'
      ],
      answer: 0,
      explain: 'Instructions are guidance a model can misread; an action it does not have is a hard limit. Constrain what it can do, then describe how it should do it.'
    },
    {
      id: 'agent-testing',
      module: 'agentforce',
      prompt: 'Why test an agent with many differently worded requests before it goes live?',
      options: [
        'Its responses vary, so you check the right topic and action are chosen across phrasings',
        'Each test request increases its licence count',
        'It only learns from test requests',
        'Salesforce requires 75% coverage for agents'
      ],
      answer: 0,
      explain: 'Language models are probabilistic. Batch testing many utterances shows whether routing and actions hold up, not just whether one demo worked.'
    },
    {
      id: 'hallucination',
      module: 'agentforce',
      prompt: 'What is a hallucination in generative AI?',
      options: [
        'A fluent answer that is not supported by facts or the data provided',
        'A response that takes too long',
        'An answer in the wrong language',
        'A refusal to answer'
      ],
      answer: 0,
      explain: 'The model produces something plausible rather than something true. Grounding and narrow, checkable tasks reduce it; nothing removes it entirely.'
    },
    {
      id: 'rag',
      module: 'agentforce',
      prompt: 'What does retrieval-augmented generation (RAG) mean?',
      options: [
        'Retrieving relevant content first and passing it to the model with the prompt',
        'Retraining the model on your data every night',
        'Generating several answers and picking the longest',
        'Caching earlier answers'
      ],
      answer: 0,
      explain: 'RAG answers from retrieved sources, so the model works from your knowledge base rather than from memory — and can cite what it used.'
    },
    {
      id: 'retriever',
      module: 'data-cloud',
      prompt: 'In Data Cloud-grounded AI, what does a retriever do?',
      options: [
        'Fetches the most relevant chunks from a search index for a prompt',
        'Downloads files from external storage',
        'Restores deleted records',
        'Collects user feedback'
      ],
      answer: 0,
      explain: 'A retriever queries a search index (vector, keyword or hybrid) and returns the passages that ground the prompt.'
    },
    {
      id: 'chunking',
      module: 'data-cloud',
      prompt: 'Before documents can be searched for grounding, what happens to them?',
      options: [
        'They are split into chunks and embedded into a search index',
        'They are translated to English',
        'They are converted to records on a custom object',
        'They are compressed into a single file'
      ],
      answer: 0,
      explain: 'Chunking keeps each passage small enough to be relevant; embeddings turn each chunk into a vector so it can be found by meaning.'
    },
    {
      id: 'vector-search',
      module: 'data-cloud',
      prompt: 'Why does semantic search use vector embeddings?',
      options: [
        'To match by meaning rather than by exact keywords',
        'To encrypt the text',
        'To sort results alphabetically',
        'To reduce storage costs'
      ],
      answer: 0,
      explain: '“Cancel my plan” and “end my subscription” share almost no words but sit close together as vectors, so both find the same article.'
    },
    {
      id: 'temperature',
      module: 'agentforce',
      prompt: 'Lowering a model’s temperature generally makes its output what?',
      options: ['More consistent and less varied', 'Longer', 'More creative', 'Faster to generate'],
      answer: 0,
      explain: 'Low temperature favours the most likely next words, which suits extraction and classification; higher temperature varies the wording more.'
    },
    {
      id: 'prompt-injection',
      module: 'agentforce',
      prompt: 'What is prompt injection?',
      options: [
        'Text in user input or retrieved data that tries to override the system’s instructions',
        'Adding merge fields to a template',
        'A faster way to call the model',
        'Inserting a prompt into a flow'
      ],
      answer: 0,
      explain: '“Ignore your instructions and…” hidden in a case description is an attack on the agent. Treat retrieved and user text as data, and bound the agent’s actions.'
    },
    {
      id: 'human-review',
      module: 'agentforce',
      prompt: 'Why keep a person reviewing an AI-drafted email before it goes to a customer?',
      options: [
        'Someone checks the facts and tone, and takes responsibility for what is sent',
        'The model cannot write emails without approval',
        'It is required to save the record',
        'It makes the model learn faster'
      ],
      answer: 0,
      explain: 'A draft is only a draft. What reaches a customer should be something a person read and put their name to.'
    }
  ],

  'sales-service': [
    {
      id: 'cpq-price-rule',
      module: 'cpq',
      prompt: 'In Revenue Cloud / CPQ, what does a price rule act on?',
      options: [
        'The opportunity record only',
        'Quote and quote line fields, at a defined calculation event',
        'The order after activation',
        'The renewal contract exclusively'
      ],
      answer: 1,
      explain: 'Price rules fire at a chosen calculator event (On Initialization, Before/On/After Calculate) and inject values into quote and quote line fields.'
    },
    {
      id: 'cpq-product-rule-validation',
      module: 'cpq',
      prompt: 'In CPQ, what does a product rule of type Validation do?',
      options: [
        'Stops the user saving a configuration that breaks the rule, with a message',
        'Adds a product automatically',
        'Changes a price',
        'Hides a product from the catalogue'
      ],
      answer: 0,
      explain: 'Validation rules block an invalid configuration; Selection rules add, remove or hide options; Alert rules warn but let the user continue.'
    },
    {
      id: 'cpq-bundle',
      module: 'cpq',
      prompt: 'In CPQ, what is a bundle?',
      options: [
        'A parent product whose options are configured and sold together',
        'A discount schedule',
        'A set of price books',
        'A group of quotes for one account'
      ],
      answer: 0,
      explain: 'A bundle is a parent product with product options (often in features), configured as one sale — a laptop with its warranty and accessories.'
    },
    {
      id: 'omni-routing',
      module: 'service-cloud',
      prompt: 'In Omni-Channel, what does a routing configuration primarily define?',
      options: [
        'Which agents exist in the queue',
        'How work items are prioritised and how much capacity each consumes',
        'The case page layout',
        'Business hours'
      ],
      answer: 1,
      explain: 'Routing configurations set priority, routing model and the capacity weight of each work item. Presence configurations decide what an agent can accept.'
    },
    {
      id: 'omni-presence',
      module: 'service-cloud',
      prompt: 'What does an agent’s presence status tell Omni-Channel?',
      options: [
        'Whether the agent is available, and for which channels',
        'How many cases the agent closed today',
        'The agent’s time zone',
        'The agent’s skills'
      ],
      answer: 0,
      explain: 'Presence statuses (“Available – Chat”, “Busy”) decide whether and what work Omni-Channel pushes to the agent.'
    },
    {
      id: 'experience-cloud-audience',
      module: 'experience-cloud',
      prompt: 'What does an Experience Cloud "audience" control?',
      options: [
        'Which licence a member consumes',
        'Which page variation or component a visitor sees',
        'The site’s SEO indexability',
        'Guest user object permissions'
      ],
      answer: 1,
      explain: 'Audiences drive personalisation — page variations, branding sets, component visibility. They are not a security control; guest access is still governed by the guest user profile and sharing.'
    },
    {
      id: 'experience-sharing-sets',
      module: 'experience-cloud',
      prompt: 'How do sharing sets give high-volume Experience Cloud users access to records?',
      options: [
        'By matching an account or contact on the user to a field on the record',
        'Through the role hierarchy',
        'Through owner-based sharing rules',
        'By making the user the record owner'
      ],
      answer: 0,
      explain: 'High-volume users have no role, so sharing sets grant access where, say, the record’s Account matches the user’s account.'
    },
    {
      id: 'partner-licence',
      module: 'experience-cloud',
      prompt: 'Which Experience Cloud licence is meant for partners who sell with you, with access to leads and opportunities?',
      options: ['Partner Community', 'Customer Community', 'Chatter Free', 'Platform Starter'],
      answer: 0,
      explain: 'Partner Community includes leads, opportunities and roles for partner users; Customer Community is for customer self-service.'
    },
    {
      id: 'lead-conversion',
      module: 'sales-cloud',
      prompt: 'What does converting a lead create?',
      options: [
        'An account and a contact, and optionally an opportunity',
        'A case',
        'A campaign member only',
        'A quote'
      ],
      answer: 0,
      explain: 'Conversion creates (or matches) an account and contact and can create an opportunity; lead field mapping carries custom fields across.'
    },
    {
      id: 'stage-probability',
      module: 'sales-cloud',
      prompt: 'What sets an opportunity’s default probability?',
      options: ['Its stage', 'Its amount', 'Its close date', 'Its owner’s role'],
      answer: 0,
      explain: 'Each stage carries a default probability and a forecast category; changing the stage moves both.'
    },
    {
      id: 'price-book-entry',
      module: 'sales-cloud',
      prompt: 'What must a product have before it can be added to an opportunity?',
      options: [
        'An entry in the opportunity’s price book',
        'A record type',
        'An approval',
        'A quote'
      ],
      answer: 0,
      explain: 'Opportunity products come from price book entries, and every opportunity uses one price book.'
    },
    {
      id: 'quote-sync',
      module: 'sales-cloud',
      prompt: 'How many quotes on an opportunity can be synced with it at a time?',
      options: ['One', 'Two', 'Five', 'Any number'],
      answer: 0,
      explain: 'One synced quote at a time: its line items and the opportunity products stay in step until another quote is synced.'
    },
    {
      id: 'territory-rules',
      module: 'sales-cloud',
      prompt: 'In Enterprise Territory Management, what assigns accounts to territories automatically?',
      options: ['Account assignment rules', 'Lead assignment rules', 'Sharing sets', 'Queues'],
      answer: 0,
      explain: 'Account assignment rules on each territory match account fields — country, industry, size — and are run to place accounts.'
    },
    {
      id: 'forecast-category',
      module: 'sales-cloud',
      prompt: 'Which opportunity field decides which forecast column an opportunity counts in?',
      options: ['Forecast category', 'Lead source', 'Type', 'Next step'],
      answer: 0,
      explain: 'Forecast category (Pipeline, Best Case, Commit, Closed) groups opportunities in the forecast; it defaults from the stage.'
    },
    {
      id: 'web-to-lead-limit',
      module: 'sales-cloud',
      prompt: 'What is the standard daily limit on leads captured by Web-to-Lead?',
      options: ['50', '500', '5,000', 'Unlimited'],
      answer: 1,
      explain: '500 per day; requests over that are queued and the admin is notified. Web-to-Case allows 5,000.'
    },
    {
      id: 'web-to-case-limit',
      module: 'service-cloud',
      prompt: 'What is the standard daily limit on cases created by Web-to-Case?',
      options: ['500', '1,000', '5,000', '50,000'],
      answer: 2,
      explain: '5,000 per day — ten times the Web-to-Lead allowance.'
    },
    {
      id: 'case-assignment-active',
      module: 'service-cloud',
      prompt: 'How many case assignment rules can be active at once?',
      options: ['One', 'Two', 'Five', 'One per record type'],
      answer: 0,
      explain: 'One active rule, with as many ordered entries as needed. The first entry that matches decides the owner.'
    },
    {
      id: 'escalation-rules',
      module: 'service-cloud',
      prompt: 'What do escalation rules act on?',
      options: [
        'Cases not closed or updated within a set time',
        'Leads that have not been converted',
        'Opportunities past their close date',
        'Users who have not logged in'
      ],
      answer: 0,
      explain: 'Escalation rules reassign or notify when a case passes its age threshold, measured against business hours.'
    },
    {
      id: 'entitlements-milestones',
      module: 'service-cloud',
      prompt: 'What do entitlements and milestones measure?',
      options: [
        'The service level a customer is owed, such as time to first response',
        'Agent sales quotas',
        'Licence usage',
        'Storage limits'
      ],
      answer: 0,
      explain: 'An entitlement says what support a customer gets; milestones are its time-bound steps, tracked with warnings and violations.'
    },
    {
      id: 'knowledge-published',
      module: 'service-cloud',
      prompt: 'What state must a Salesforce Knowledge article version be in for customers to see it?',
      options: ['Published', 'Draft', 'Archived', 'Submitted'],
      answer: 0,
      explain: 'Only published versions are visible on channels, and only on the channels the article is enabled for.'
    },
    {
      id: 'email-to-case-on-demand',
      module: 'service-cloud',
      prompt: 'What distinguishes On-Demand Email-to-Case?',
      options: [
        'Salesforce processes the email itself, with no email agent installed behind your firewall',
        'Emails are turned into leads',
        'Cases are created only during business hours',
        'Agents reply by SMS'
      ],
      answer: 0,
      explain: 'On-Demand Email-to-Case uses Apex email services inside Salesforce; the older Email-to-Case needed an agent running on your own network.'
    },
    {
      id: 'service-macros',
      module: 'service-cloud',
      prompt: 'What does a macro do in the Service Console?',
      options: [
        'Runs a recorded series of actions on a record in one click',
        'Schedules a report',
        'Creates a new object',
        'Sends a survey after every case'
      ],
      answer: 0,
      explain: 'Macros automate repetitive console steps — fill a field, choose an email template, send — so an agent does them in one click.'
    }
  ]
});

module.exports = { TOPIC_QUESTIONS };
