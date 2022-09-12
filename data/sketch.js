
let geniusBirdJson;

var sceneManager;

const MENU_SCENE = 0;
const PLAY_SCENE = 1;
const TRAIN_SCENE = 2;
const WATCH_SCENE = 3;

function preload(){
    geniusBirdJson = loadJSON("data\\birdBrain_5-10-10-1_ai.json");
    console.log(geniusBirdJson);

    sceneManager = new SceneManager();

    sceneManager.addScene(new MainMenuScene());
    sceneManager.addScene(new PlayScene());
    sceneManager.addScene(new TrainScene());
    sceneManager.addScene(new WatchScene());
}

function setup(){
    geniusBirdBrain = NeuralNetwork.deserialize(geniusBirdJson);
    
    let cnv;
    if(windowWidth<1000)
        cnv = createCanvas(windowWidth, windowHeight);
    else
        cnv = createCanvas(375, 812);
    let x = (windowWidth - width) / 2;
    let y = (windowHeight - height) / 2;
    cnv.position(x, y);
}

function draw(){
    sceneManager.update();
    sceneManager.draw();
}

function keyPressed(key){
    sceneManager.keyPressed(key);
}

function mousePressed(){
    sceneManager.mousePressed();
}