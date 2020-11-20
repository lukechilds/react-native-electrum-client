const ElectrumClient = require("../lib/electrum_client");
const clients = require("./clients");

let electrumKeepAlive = () => null;
let electrumKeepAliveInterval = 60000;

const getTimeout = ({ arr = undefined, timeout = 1000 } = {}) => {
	try {
		if (arr && Array.isArray(arr)) return arr.length * timeout;
		return timeout;
	} catch {
		return timeout;
	}
}

const promiseTimeout = (ms, promise) => {
	let id;
	let timeout = new Promise((resolve) => {
		id = setTimeout(() => {
			resolve({ error: true, data: "Timed Out." });
		}, ms);
	});
	
	return Promise.race([
		promise,
		timeout
	]).then((result) => {
		clearTimeout(id);
		try {if ("error" in result && "data" in result) return result;} catch {}
		return { error: false, data: result };
	});
};

const pauseExecution = (duration = 500) => {
	return new Promise(async (resolve) => {
		try {
			const wait = () => resolve({error: false});
			await setTimeout(wait, duration);
		} catch (e) {
			console.log(e);
			resolve({error: true});
		}
	});
};

const getDefaultPeers = (network, protocol) => {
	return require("./peers.json")[network].map(peer => {
		try {
			return { ...peer, protocol };
		} catch {}
	});
};

const pingServer = ({ id = Math.random() } = {}) => {
	const method = "pingServer";
	return new Promise(async (resolve) => {
		try {
			if (clients.mainClient[clients.network] === false) await connectToRandomPeer(clients.network, clients.peers[clients.network]);
			const { error, data } = await promiseTimeout(getTimeout(), clients.mainClient[clients.network].server_ping());
			resolve({ id, error, method, data, network: clients.network });
		} catch (e) {
			resolve({ id, error: true, method, data: e, network: clients.network });
		}
	});
};

//peers = A list of peers acquired from default electrum servers using the getPeers method.
//customPeers = A list of peers added by the user to connect to by default in lieu of the default peer list.
const start = ({ id = Math.random(), network = "", peers = [], customPeers = []} = {}) => {
	const method = "connectToPeer";
	return new Promise(async (resolve) => {
		try {
			if (!network) {
				resolve({
					id,
					method: "connectToPeer",
					error: true,
					data: "No network specified",
				});
				return;
			}
			//Clear/Remove any previous keep-alive message.
			try {clearInterval(electrumKeepAlive);} catch {}
			clients.network = network;
			let customPeersLength = 0;
			try {customPeersLength = customPeers.length;} catch {}
			//Attempt to connect to specified peer
			let connectionResponse = { error: true, data: "" };
			if (customPeersLength > 0) {
				const { host = "", port = "", protocol = "ssl" } = customPeers[0];
				connectionResponse = await connectToPeer({ host, port, protocol, network });
			} else {
				//Attempt to connect to random peer if none specified
				connectionResponse = await connectToRandomPeer(network, peers);
			}
			resolve({
				...connectionResponse,
				id,
				method: "connectToPeer",
				customPeers,
				network
			});
		} catch (e) {
			console.log(e);
			resolve({ error: true, method, data: e });
		}
	});
};

const connectToPeer = ({ port = 50002, host = "", protocol = "ssl", network = "bitcoin" } = {}) => {
	return new Promise(async (resolve) => {
		try {
			clients.network = network;
			let needToConnect = clients.mainClient[network] === false;
			let connectionResponse = { error: false, data: clients.peer[network] };
			if (!needToConnect) {
				//Ensure the server is still alive
				const pingResponse = await pingServer();
				if (pingResponse.error) {
					await disconnectFromPeer({ network });
					needToConnect = true;
				}
			}
			if (needToConnect) {
				clients.mainClient[network] = new ElectrumClient(port, host, protocol);
				connectionResponse = await promiseTimeout(1000, clients.mainClient[network].connect());
				if (!connectionResponse.error) {
					try {
						//Clear/Remove Electrum's keep-alive message.
						clearInterval(electrumKeepAlive);
						//Start Electrum's keep-alive function. It’s sent every minute as a keep-alive message.
						electrumKeepAlive = setInterval(async () => {
							try {pingServer({ id: Math.random() });} catch {}
						}, electrumKeepAliveInterval);
					} catch (e) {}
					clients.peer[network] = { port, host, protocol };
				}
			}
			await pauseExecution();
			resolve(connectionResponse);
		} catch (e) {resolve({ error: true, data: e });}
	});
};

const connectToRandomPeer = async (network, peers = [], protocol = "ssl") => {
	//Peers can be found in peers.json.
	//Additional Peers can be located here in servers.json & servers_testnet.json for reference: https://github.com/spesmilo/electrum/tree/master/electrum
	let hasPeers = false;
	try {
		hasPeers = (Array.isArray(peers) && peers.length) || (Array.isArray(clients.peers[network]) && clients.peers[network].length);
	} catch {}
	if (hasPeers) {
		if (Array.isArray(peers) && peers.length) {
			//Update peer list
			clients.peers[network] = peers;
		} else {
			//Set the saved peer list
			peers = clients.peers[network];
		}
	} else {
		//Use the default peer list for a connection if no other peers were passed down and no saved peer list is present.
		peers = getDefaultPeers(network, protocol);
	}
	const initialPeerLength = peers.length; //Acquire length of our default peers.
	//Attempt to connect to a random default peer. Continue to iterate through default peers at random if unable to connect.
	for (let i = 0; i <= initialPeerLength; i++) {
		try {
			const randomIndex = peers.length * Math.random() | 0;
			const peer = peers[randomIndex];
			let port = "50002";
			let host = "";
			if (hasPeers) {
				port = peer.port;
				host = peer.host;
				protocol = peer.protocol;
			} else {
				port = peer[peer.protocol];
				host = peer.host;
				protocol = peer.protocol;
			}
			const connectionResponse = await connectToPeer({ port, host, protocol, network });
			if (connectionResponse.error === false && connectionResponse.data) {
				return {
					error: connectionResponse.error,
					method: "connectToRandomPeer",
					data: connectionResponse.data,
					network
				};
			} else {
				//clients.mainClient[network].close && clients.mainClient[network].close();
				clients.mainClient[network] = false;
				if (peers.length === 1) {
					return {
						error: true,
						method: "connectToRandomPeer",
						data: connectionResponse.data,
						network
					};
				}
				peers.splice(randomIndex, 1);
			}
		} catch (e) {console.log(e);}
	}
	return { error: true, method: "connectToRandomPeer", data: "Unable to connect to any peer." };
};

const stop = async ({ network = "" } = {}) => {
	return new Promise(async (resolve) => {
		try {
			//Clear/Remove Electrum's keep-alive message.
			clearInterval(electrumKeepAlive);
			//Disconnect from peer
			const response = await disconnectFromPeer({ network });
			resolve(response);
		} catch (e) {
			resolve({ error: true, data: e });
		}
	});
	
};

const disconnectFromPeer = async ({ id = Math.random(), network = "" } = {}) => {
	const failure = (data = {}) => {
		return { error: true, id, method: "disconnectFromPeer", data };
	};
	try {
		//console.log("Disconnecting from any previous peer...");
		if (clients.mainClient[network] === false) {
			//No peer to disconnect from...
			return {
				error: false,
				data: "No peer to disconnect from.",
				id,
				network,
				method: "disconnectFromPeer"
			};
		}
		//Attempt to disconnect from peer...
		clients.mainClient[network].close();
		clients.mainClient[network] = false;
		clients.network = "";
		await pauseExecution();
		return { error: false, id, method: "disconnectFromPeer", network, data: "Disconnected..." };
	} catch (e) {
		failure(e);
	}
};

const getAddressScriptHashBalance = ({ scriptHash = "", id = Math.random(), network = "" } = {}) => {
	const method = "getAddressScriptHashBalance";
	return new Promise(async (resolve) => {
		try {
			if (clients.mainClient[network] === false) await connectToRandomPeer(network, clients.peers[network]);
			const { error, data } = await promiseTimeout(getTimeout(), clients.mainClient[network].blockchainScripthash_getBalance(scriptHash));
			resolve({ id, error, method, data, scriptHash, network });
		} catch (e) {
			console.log(e);
			return { id, error: true, method, data: e, network };
		}
	});
};

const getPeers = ({ id = Math.random(), network = "" } = {}) => {
	const method = "getPeers";
	return new Promise(async (resolve) => {
		try {
			if (clients.mainClient[network] === false) await connectToRandomPeer(network, clients.peers[network]);
			const data = await clients.mainClient[network].serverPeers_subscribe();
			resolve({ id, error: false, method, data, network });
		} catch (e) {
			console.log(e);
			resolve({ id, error: true, method, data: null, network });
		}
	});
};

const subscribeHeader = async ({ id = "subscribeHeader", network = "", onReceive = () => null } = {}) => {
	try {
		if (clients.mainClient[network] === false) await connectToRandomPeer(network, clients.peers[network]);
		clients.mainClient[network].subscribe.on('blockchain.headers.subscribe', (data) => {
			console.log("Received header.");
			console.log(data);
			onReceive(data)
		});
		return { id, error: false, method: "subscribeHeader", data: "Subscribed", network };
	} catch (e) {
		return { id, error: true, method: "subscribeHeader", data: e, network };
	}
};

const subscribeAddress = async ({ id = Math.random(), scriptHash = "", network = "bitcoin", onReceive = (data) => console.log(data) } = {}) => {
	try {
		if (clients.mainClient[network] === false) await connectToRandomPeer(network, clients.peers[network]);
		//Ensure this address is not already subscribed
		if (clients.subscribedAddresses[network].includes(scriptHash)) return { id, error: false, method: "subscribeAddress", data: "" };
		const res = await promiseTimeout(10000,  clients.mainClient[network].subscribe.on('blockchain.scripthash.subscribe', (onReceive)));
		if (res.error) return { ...res, id, method: "subscribeAddress" };
		const response = await promiseTimeout(10000, clients.mainClient[network].blockchainScripthash_subscribe(scriptHash));
		if (!response.error) clients.subscribedAddresses[network].push(scriptHash);
		return { ...response, id, method: "subscribeAddress" };
	} catch (e) {
		return { id, error: true, method: "subscribeAddress", data: e };
	}
};

const getFeeEstimate = ({ blocksWillingToWait = 8, id = Math.random(), network = "" } = {}) => {
	const method = "getFeeEstimate";
	return new Promise(async (resolve) => {
		try {
			if (clients.mainClient[network] === false) await connectToRandomPeer(network, clients.peers[network]);
			const response = await promiseTimeout(getTimeout(), clients.mainClient[network].blockchainEstimatefee(blocksWillingToWait));
			resolve({ ...response, id, method, network });
		} catch (e) {
			console.log(e);
			resolve({ id, error: true, method, data: e, network });
		}
	});
};


module.exports = {
	start,
	stop,
	pingServer,
	getAddressScriptHashBalance,
	getPeers,
	subscribeHeader,
	subscribeAddress,
	getFeeEstimate
};
