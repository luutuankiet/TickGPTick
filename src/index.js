const TickTickClient = require('./lib/TickTickClient')
const {
  expandTasksIntoAtomicTasks,
  expandDescriptionsForAiPrompt
} = require('./lib/OpenAI');
const { getExpandedNumberFromTags } = require('./lib/utils');
const fs = require('fs');
const path = require('path');

// Add this function to create a log directory if it doesn't exist
function ensureLogDirectory() {
  const logDir = path.join(__dirname, 'logs');
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir);
  }
  return logDir;
}

// Add this function to log to file
function logToFile(message) {
  const logDir = ensureLogDirectory();
  const date = new Date();
  const logFile = path.join(logDir, `tickgptick-${date.toISOString().split('T')[0]}.log`);
  
  const timestamp = date.toISOString();
  const logMessage = `[${timestamp}] ${message}\n`;
  
  fs.appendFileSync(logFile, logMessage);
  console.log(message);
}

// Add the missing escapeRegExp function
function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

(async () => {
  const ticktickClient = await TickTickClient.createClient(
    process.env.TICKUSERNAME,
    process.env.TICKPASSWORD
  )

  const removeTags = async tasks => {
    const removeTagsPromises = []
    for (let index = 0; index < tasks.length; index++) {
      const task = tasks[index]
      removeTagsPromises.push(
        ticktickClient.removeTagsByPredicate(task, tag =>
          tag.includes('expand')
        )
      )
    }
    return Promise.all(removeTagsPromises)
  }

  const createSubTasks = async (savedtasks, newTasks) => {
    const addedSubtasksPromises = []
    for (let index = 0; index < savedtasks.length; index++) {
      const { projectId, ...parent } = savedtasks[index]
      const newTaskList = newTasks[index]
      addedSubtasksPromises.push(
        ticktickClient.addSubstacksToTask(parent, projectId, newTaskList)
      )
    }

    return Promise.all(addedSubtasksPromises)
  }

  const removeTagsAndAddSubTasks = async (tasks, newTasks) => {
    const savedTagless = await removeTags(tasks)
    await createSubTasks(savedTagless, newTasks)
  }

  const replaceDescriptionWithAi = async updates => {
    logToFile("=== CHECKING FOR AI PROMPTS ===");
    
    // Updated regex to use [\s\S]* which matches any character including newlines
    const aiPromptRegex = /(?<=ai\{\{)([\s\S]*?)(?=\}\})/g
    
    // Extract all prompts from all tasks
    const tasksWithPrompts = updates.map(task => {
      const matches = [];
      let match;
      const regex = new RegExp(aiPromptRegex);
      const content = task.content || '';
      
      while ((match = regex.exec(content)) !== null) {
        matches.push(match[0]);
      }
      return { task, matches };
    }).filter(item => item.matches.length > 0);
    
    logToFile(`Found ${tasksWithPrompts.length} tasks with AI prompts`);
    
    // Flatten all prompts for processing
    const allPrompts = tasksWithPrompts.flatMap(item => item.matches);

    if (allPrompts.length > 0) {
      logToFile(`Total AI prompts to process: ${allPrompts.length}`);
      
      tasksWithPrompts.forEach((item, idx) => {
        logToFile(`Task ${idx+1}: "${item.task.title}" has ${item.matches.length} prompts`);
        item.matches.forEach((prompt, i) => {
          logToFile(`  Prompt ${i+1}: "${prompt.substring(0, 50)}${prompt.length > 50 ? '...' : ''}"`);
        });
      });
      
      // Get AI responses for all prompts
      logToFile("Sending prompts to OpenAI...");
      const aiResponses = await Promise.all(
        allPrompts.map(expandDescriptionsForAiPrompt)
      );
      
      // Create a map of prompts to responses
      const promptToResponse = {};
      allPrompts.forEach((prompt, index) => {
        promptToResponse[prompt] = aiResponses[index];
        logToFile(`Prompt: "${prompt.substring(0, 30)}..." => Response: "${aiResponses[index].substring(0, 30)}..."`);
      });
      
      // Update each task's content
      logToFile("Updating tasks with AI responses...");
      const updatedTasks = updates.map(task => {
        if (!task.content) return task;
        
        let updatedContent = task.content;
        // Replace each ai{{...}} with its corresponding response
        let match;
        const regex = new RegExp(aiPromptRegex);
        while ((match = regex.exec(task.content)) !== null) {
          const prompt = match[0];
          const response = promptToResponse[prompt] || '';
          // Use a global replacement with the specific prompt
          updatedContent = updatedContent.replace(
            new RegExp(`ai\\{\\{${escapeRegExp(prompt)}\\}\\}`, 'g'), 
            response
          );
        }
        
        const changed = updatedContent !== task.content;
        if (changed) {
          logToFile(`Updated task: "${task.title}"`);
        }
        
        return { ...task, content: updatedContent };
      }).filter(task => task.content !== updates.find(u => u.id === task.id)?.content);
      
      if (updatedTasks.length > 0) {
        logToFile(`Sending ${updatedTasks.length} updated tasks to TickTick`);
        return ticktickClient.updateTasks(updatedTasks);
      } else {
        logToFile("No tasks were updated");
      }
    } else {
      logToFile("No AI prompts found in tasks");
    }
  }

  const handleTaskCreation = async updates => {
    logToFile("=== CHECKING FOR EXPANDABLE TASKS ===");
    
    const expandableUpdates = updates.filter(
      ({ tags }) => tags && tags.some(tag => tag.includes('expand'))
    )
    
    logToFile(`Found ${expandableUpdates.length} tasks with 'expand' tags`);
    
    if (expandableUpdates.length > 0) {
      expandableUpdates.forEach((task, idx) => {
        const maxNo = getExpandedNumberFromTags(task.tags);
        logToFile(`Task ${idx+1}: "${task.title}" with expand-${maxNo} tag`);
      });
      
      logToFile("Expanding tasks into atomic subtasks...");
      const newTasks = await Promise.all(
        expandableUpdates.map(it => {
          const maxNo = getExpandedNumberFromTags(it.tags);
          return expandTasksIntoAtomicTasks(it, maxNo);
        })
      );
      
      logToFile("Removing 'expand' tags and adding subtasks...");
      return removeTagsAndAddSubTasks(expandableUpdates, newTasks);
    }
  }

  let lastChecked = Date.now()
  let loopCount = 0;
  do {
    try {
      // Only log every 60 iterations (about once per minute) or when there are updates
      loopCount++;
      const shouldLog = loopCount % 60 === 0;
      
      if (shouldLog) {
        logToFile(`Checking for updates since ${new Date(lastChecked).toISOString()}`);
      }
      
      const {
        checkPoint,
        syncTaskBean: { update }
      } = await ticktickClient.getUpdatesSince(lastChecked)
      lastChecked = checkPoint
      
      // Only log if there are updates or on the periodic log
      if (update.length > 0 || shouldLog) {
        logToFile(`Received ${update.length} task updates from TickTick`);
      }
      
      if (update.length > 0) {
        // Reset the counter when we have updates to ensure we log the next check
        loopCount = 0;
        
        await handleTaskCreation(update)
        await replaceDescriptionWithAi(update)
      } else if (shouldLog) {
        logToFile("No updates to process in the last minute");
      }
      
      // Wait for the next check without logging
      await new Promise(resolve => setTimeout(resolve, 1000))
    } catch (e) {
      // Always log errors
      logToFile(`ERROR: ${e.message}`);
      console.error("Something went wrong", e);
      
      // Reset counter on errors to ensure we log the next check
      loopCount = 0;
    }
  } while (true)
})()
