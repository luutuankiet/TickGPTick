const { OpenAI } = require('openai')
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
})

const DESCRIPTION_TEMPLATES = ["Use {} to create some context for subsequent tasks", "parent task was titled {}"];

const extractParentInformationOrReturnDescription = async (content) => { 
  console.log(`Extracting parent information from content: ${content.substring(0, 50)}${content.length > 50 ? '...' : ''}`);
  
  const regex = /description:?(.*)parent_title:?(.+)|(.*)/gms;
  let matches;
  
  const set = new Set();
  while ((matches = regex.exec(content)) !== null) {
      if (matches.index === regex.lastIndex) {
          regex.lastIndex++;
      }      

      matches.forEach(it => set.add(it))
    }

    const arrSet = set.size > 1 ? [...set].slice(1).filter(it => it) : [...set].filter(it => it).slice(0, 1);
    
    const result = arrSet.map((it, idx) => DESCRIPTION_TEMPLATES[idx].replace("{}", it));
    console.log(`Extracted context clues: ${JSON.stringify(result)}`);
    return result;
}

const expandTasksIntoAtomicTasks = async ({ title, content }, maxTasks = 5) => {
  console.log(`\n=== EXPAND TASK REQUEST ===`);
  console.log(`Task title: "${title}"`);
  console.log(`Task content: "${content}"`);
  console.log(`Requested subtasks: ${maxTasks}`);
  
  const additionalContextClues = (await extractParentInformationOrReturnDescription(content)).map(content => ({ role: "user", content }));
  const messages = [{ role: "user", content: `make exactly ${maxTasks} todo list steps simplifying task "${title}" into smaller tasks` }, ...additionalContextClues]
  
  console.log(`\nSending to OpenAI:`);
  console.log(`Messages: ${JSON.stringify(messages, null, 2)}`);

  const functionDef = { 
    name: "createSmallerTasks",
    description: "Takes a task, and turns it into smaller (micro) and more easily managable steps.",
    parameters: { 
      type: "object", 
      properties: {
        tasks: { 
          type: "array",
          items: { 
            type: "object",
            properties: { 
              "description": {
                type: "string", 
                description: "Some suggestions of how to achieve it"
              },
              "title": { 
                type: "string", 
                description: "The title of the task, summarising what to do"
              }
            }
          },
          description: "The array of smaller atomic tasks",
        }
      }
    }
  };
  
  console.log(`Function definition: ${JSON.stringify(functionDef, null, 2)}`);

  try {
    const response = await openai.chat.completions.create({
      model:"gpt-4o-mini",
      messages,
      functions: [functionDef],
      function_call: "auto"
    });

    const res = response.choices[0]?.message ?? {};
    console.log(`\nOpenAI Response:`);
    console.log(`Response type: ${res['function_call'] ? 'Function call' : 'Message'}`);
    
    if (res['function_call']) { 
      const functionArgs = JSON.parse(res['function_call'].arguments);
      console.log(`Function name: ${res['function_call'].name}`);
      console.log(`Function arguments: ${JSON.stringify(functionArgs, null, 2)}`);
      
      const { tasks } = functionArgs;
      console.log(`\nGenerated ${tasks.length} subtasks:`);
      tasks.forEach((task, i) => {
        console.log(`  ${i+1}. ${task.title}`);
        console.log(`     ${task.description}`);
      });
      
      return tasks; 
    }

    console.log(`Unexpected response format. No function call found.`);
    return [];
  } catch (error) {
    console.error(`\nError calling OpenAI API for task expansion:`);
    console.error(error.message);
    if (error.response) {
      console.error(`Status: ${error.response.status}`);
      console.error(`Data: ${JSON.stringify(error.response.data)}`);
    }
    return [];
  }
}

const expandDescriptionsForAiPrompt = async description => {
  console.log(`\n=== AI PROMPT REQUEST ===`);
  console.log(`Original prompt: "${description.substring(0, 100)}${description.length > 100 ? '...' : ''}"`);
  
  const prompt = `[short response][non conversational] ${description}`;
  console.log(`Modified prompt: "${prompt.substring(0, 100)}${prompt.length > 100 ? '...' : ''}"`);

  try {
    const response = await openai.chat.completions.create({
      max_tokens: 256,
      model:"gpt-4o-mini",
      messages: [{ role: 'user', content: prompt }],
      temperature: 0
    });

    const content = response.choices[0].message.content.trimStart();
    console.log(`\nOpenAI Response:`);
    console.log(`Response length: ${content.length} characters`);
    console.log(`Response content: "${content.substring(0, 100)}${content.length > 100 ? '...' : ''}"`);
    
    return content;
  } catch (error) {
    console.error(`\nError calling OpenAI API for description expansion:`);
    console.error(error.message);
    if (error.response) {
      console.error(`Status: ${error.response.status}`);
      console.error(`Data: ${JSON.stringify(error.response.data)}`);
    }
    return "Error generating content. Please try again.";
  }
}

module.exports = { expandTasksIntoAtomicTasks, expandDescriptionsForAiPrompt }
