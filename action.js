const core = require('@actions/core');
const github = require('@actions/github');
const asana = require('asana');
const matchAll = require("match-all");
const unique = require('array-unique');

async function moveSection(client, taskId, targets) {
  const task = await client.tasks.findById(taskId);

  targets.forEach(async target => {
    const targetProject = task.projects.find(project => project.name === target.project);
    if (!targetProject) {
      core.info(`This task does not exist in "${target.project}" project`);
      return;
    }
    let targetSection = await client.sections.findByProject(targetProject.gid)
      .then(sections => sections.find(section => section.name === target.section));
    if (targetSection) {
      await client.sections.addTask(targetSection.gid, { task: taskId });
      core.info(`Moved to: ${target.project}/${target.section}`);
    } else {
      core.error(`Asana section ${target.section} not found.`);
    }
  });
}

async function findComment(client, taskId, commentId) {
  let stories;
  try {
    const storiesCollection = await client.tasks.stories(taskId);
    stories = await storiesCollection.fetch(200);
  } catch (error) {
    throw error;
  }

  return stories.find(story => story.text.indexOf(commentId) !== -1);
}

async function addComment(client, taskId, commentId, text, isPinned) {
  if(commentId){
    text += '\n'+commentId+'\n';
  }
  try {
    const comment = await client.tasks.addComment(taskId, {
      text: text,
      is_pinned: isPinned,
    });
    return comment;
  } catch (error) {
    console.error('rejecting promise', error);
  }
}

async function buildClient(asanaPAT) {
  return asana.Client.create({
    defaultHeaders: { 'asana-enable': 'new-sections,string_ids' },
    logAsanaChangeWarnings: false
  }).useAccessToken(asanaPAT).authorize();
}

async function action() {  
  const 
    ASANA_PAT = core.getInput('asana-pat', {required: true}),
    ACTION = core.getInput('action', {required: true}),
    PULL_REQUEST = github.context.payload.pull_request,
    BODY = github.context.payload.pull_request.body
    TITLE = github.context.payload.pull_request.title
    LITTLESTRING = ' ';
    BIGSTRING = TITLE + LITTLESTRING + BODY;
  ;

  console.log('pull_request', PULL_REQUEST);

  const client = await buildClient(ASANA_PAT);
  if(client === null){
    throw new Error('client authorization failed');
  }

  const pattern = /(wip)/gi;
        if (pattern.test(TITLE) == true) {
            console.log("found WIP: flag in PR title, no asana actions will be done")
            return;
        }
      
  const asanaTaskNames = unique( matchAll(BIGSTRING,  /(LHD\-[0-9]{1,5})/g).toArray());
  console.log(asanaTaskNames);
  
  let foundAsanaTasks = [];
  var user = await client.users.me();
    const workspaceId = user.workspaces[0].gid;
    for (item of asanaTaskNames) {
        var result = await client.tasks.searchInWorkspace(workspaceId, {text: item})
            task = result.data[0].gid
            foundAsanaTasks.push(task); 
    }
  console.info(`found ${foundAsanaTasks.length} taskIds:`, foundAsanaTasks.join(','));
  console.info('calling', ACTION);
  switch(ACTION){
    case 'assert-link': {
      const githubToken = core.getInput('github-token', {required: true});
      const linkRequired = core.getInput('link-required', {required: true}) === 'true';
      const octokit = new github.GitHub(githubToken);
      const statusState = (!linkRequired || foundAsanaTasks.length > 0) ? 'success' : 'error';
      core.info(`setting ${statusState} for ${github.context.payload.pull_request.head.sha}`);
      octokit.repos.createStatus({
        ...github.context.repo,
        'context': 'asana-link-presence',
        'state': statusState,
        'description': 'asana link not found',
        'sha': github.context.payload.pull_request.head.sha,
      });
      break;
    }
    case 'add-comment': {
      const commentId = core.getInput('comment-id'),
        htmlText = core.getInput('text', {required: true}),
        isPinned = core.getInput('is-pinned') === 'true';
      const comments = [];
      for(const taskId of foundAsanaTasks) {
        if(commentId){
          const comment = await findComment(client, taskId, commentId);
          if(comment){
            console.info('found existing comment', comment.gid);
            continue;
          }
        }
        const comment = await addComment(client, taskId, commentId, htmlText, isPinned);
        comments.push(comment);
      };
      return comments;
    }
    case 'remove-comment': {
      const commentId = core.getInput('comment-id', {required: true});
      const removedCommentIds = [];
      for(const taskId of foundAsanaTasks) {
        const comment = await findComment(client, taskId, commentId);
        if(comment){
          console.info("removing comment", comment.gid);
          try {
            await client.stories.delete(comment.gid);
          } catch (error) {
            console.error('rejecting promise', error);
          }
          removedCommentIds.push(comment.gid);
        }
      }
      return removedCommentIds;
    }
    case 'complete-task': {
      const isComplete = core.getInput('is-complete') === 'true';
      const taskIds = [];
      for(const taskId of foundAsanaTasks) {
        console.info("marking task", taskId, isComplete ? 'complete' : 'incomplete');
        try {
          await client.tasks.update(taskId, {
            completed: isComplete
          });
        } catch (error) {
          console.error('rejecting promise', error);
        }
        taskIds.push(taskId);
      };
      return taskIds;
    }
    case 'move-section': {
      const targetJSON = core.getInput('targets', {required: true});
      const targets = JSON.parse(targetJSON);
      const movedTasks = [];
      for(const taskId of foundAsanaTasks) {
        await moveSection(client, taskId, targets);
        movedTasks.push(taskId);
      }
      return movedTasks;
    }
    default:
      core.setFailed("unexpected action ${ACTION}");
  }
}

module.exports = {
  action,
  default: action,
  buildClient: buildClient
};