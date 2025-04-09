const axios = require('axios')
const { filter } = require('lodash')

// Add a variable to track polling count
let pollCount = 0;

class TickTickClient {
  constructor (tickTickInstance) {
    this.ticktickInstance = tickTickInstance
    console.log("TickTick client initialized");
  }

  // There is no token based API for TickTick unfortunately. There is Oauth now, but I like this interface fine.
  // I have to fake a cookie based on a typical user/password login.
  static async createClient (username, password) {
    console.log(`Creating TickTick client for user: ${username}`);
    
    const tickTickInstance = axios.create({
      baseURL: 'https://api.ticktick.com/api/v2'
    })
    tickTickInstance.defaults.headers.common['x-device'] = JSON.stringify({"platform":"web","os":"macOS 10.15.7","device":"Chrome 134.0.0.0","name":"","version":6240,"id":"67e049e95bcccd664f1ff841","channel":"website","campaign":"","websocket":""})

    console.log("Authenticating with TickTick...");
    try {
      const { token } = await tickTickInstance
        .post('/user/signon?wc=true&remember=true', { username, password })
        .then(({ data }) => data)

      console.log("Authentication successful, token received");
      tickTickInstance.defaults.headers.common['Cookie'] = `t=${token};`
      return new TickTickClient(tickTickInstance)
    } catch (error) {
      console.error("Authentication failed:", error.message);
      throw new Error(`TickTick authentication failed: ${error.message}`);
    }
  }

  async getUpdatesSince (dateTime) {
    // Only log every 60 polls (approximately once per minute)
    pollCount++;
    const shouldLog = pollCount % 60 === 0;
    
    if (shouldLog) {
      console.log(`Fetching updates since: ${new Date(dateTime).toISOString()}`);
    }
    
    try {
      const response = await this.ticktickInstance.get(`/batch/check/${dateTime}`);
      
      // Only log if there are updates or on the periodic log
      const updateCount = response.data.syncTaskBean?.update?.length || 0;
      
      if (updateCount > 0 || shouldLog) {
        console.log(`Received updates, checkpoint: ${response.data.checkPoint}`);
        console.log(`Update count: ${updateCount}`);
        
        // Reset counter when we have updates
        if (updateCount > 0) {
          pollCount = 0;
        }
      }
      
      return response.data;
    } catch (error) {
      console.error(`Error fetching updates: ${error.message}`);
      // Reset counter on errors
      pollCount = 0;
      throw error;
    }
  }

  async updateTasks (tasks) {
    console.log(`Updating ${tasks.length} tasks in TickTick`);
    try {
      const payload = { update: tasks };
      const response = await this.ticktickInstance.post('/batch/task', payload);
      console.log(`Tasks updated successfully`);
      return response;
    } catch (error) {
      console.error(`Error updating tasks: ${error.message}`);
      throw error;
    }
  }

  async updateTask (task) {
    console.log(`Updating single task: ${task.title}`);
    return this.updateTasks([task]);
  }

  async removeTags (task, tagsToRemove) {
    console.log(`Removing tags from task "${task.title}": ${JSON.stringify(tagsToRemove)}`);
    try {
      const newTags = filter(task.tags, el => tagsToRemove.indexOf(el) !== -1);
      console.log(`New tags: ${JSON.stringify(newTags)}`);
      
      const modifiedTask = { ...task, tags: newTags };
      const updatePayload = { update: [modifiedTask] };
      
      await this.ticktickInstance.post('/batch/task', updatePayload);
      console.log(`Tags removed successfully`);
      return modifiedTask;
    } catch (error) {
      console.error(`Error removing tags: ${error.message}`);
      throw error;
    }
  }

  async removeTagsByPredicate (task, tagsPredicate) {
    console.log(`Removing tags by predicate from task "${task.title}"`);
    const tagsToRemove = task.tags.filter(it => !tagsPredicate(it));
    console.log(`Tags to remove: ${JSON.stringify(tagsToRemove)}`);
    return this.removeTags(task, tagsToRemove);
  }

  async addSubstacksToTask (parent, projectId, substacks) {
    console.log(`Adding ${substacks.length} subtasks to parent task "${parent.title}"`);
    try {
      const addingDate = new Date().toISOString();

      const substackUpdates = substacks.map(({title, description}) => {
        console.log(`Creating subtask: "${title}"`);
        return {
          title,
          startDate: addingDate,
          modifiedDate: addingDate,
          dueDate: parent.dueDate ?? addingDate,
          projectId,
          parentId: parent.id,
          content: `description: ${description}\n\nparent_title: ${parent.title}`
        };
      });
      
      const payload = { add: substackUpdates };
      console.log(`Sending ${substackUpdates.length} subtasks to TickTick API`);

      const response = await this.ticktickInstance.post('/batch/task', payload);
      const addedTasks = Object.keys(response.data['id2etag']);
      console.log(`Successfully added ${addedTasks.length} subtasks`);

      const newlyAddedIds = addedTasks.map(taskId => ({
        taskId,
        parentId: parent.id,
        projectId
      }));

      console.log(`Setting parent relationships for ${newlyAddedIds.length} subtasks`);
      const parentResponse = await this.ticktickInstance.post('/batch/taskParent', newlyAddedIds);
      console.log(`Parent relationships set successfully`);
      
      return parentResponse.data;
    } catch (error) {
      console.error(`Error adding subtasks: ${error.message}`);
      throw error;
    }
  }
}

module.exports = TickTickClient
