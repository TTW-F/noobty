const ws = new WebSocket(process.argv[2]);
ws.onmessage = e => console.log("WS-EVENT", e.data);
ws.onopen = () => ws.send(JSON.stringify({type:"ping"}));
ws.onclose = () => console.log("WS-CLOSED");
setTimeout(() => process.exit(0), 9000);
