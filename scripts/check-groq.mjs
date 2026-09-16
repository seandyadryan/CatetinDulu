import 'dotenv/config';
const res=await fetch('https://api.groq.com/openai/v1/models',{headers:{authorization:`Bearer ${process.env.GROQ_API_KEY}`}});
const body=await res.json();console.log({status:res.status,models:body.data?.map(x=>x.id),error:body.error});
