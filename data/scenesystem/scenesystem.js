class Scene{
    constructor(){
        this.started = false;
        this.sceneManager = null;
    }

    start(){
        console.log("Scene started");
    }

    update(){
        if(!this.started){
            this.start();
            this.started = true;
        }
    }

    draw(){

    }

    keyPressed(key){
        
    }

    mouseReleased(){

    }

    exit(){

    }
}

class SceneManager{
    constructor(){
        this.scenes = [];
        this.activeSceneIndex = 0;
        this.getActiveScene = () => {return this.scenes[this.activeSceneIndex]};
        this.ctx = {};
    }


    addScene(scene){
        this.scenes.push(scene);
        scene.sceneManager = this;
    }

    start(){

    }

    update(){
        this.getActiveScene().update();
    }

    draw(){
        push(); //this push and pop functions perfent the scene from changing the global settings
            this.getActiveScene().draw();
        pop();
    }

    keyPressed(key){
        this.getActiveScene().keyPressed(key);
    }

    mouseReleased(){
        this.getActiveScene().mouseReleased();
    }

    nextScene(){
        if(this.activeSceneIndex < this.scenes.length - 1){
            this.openScene(this.activeSceneIndex + 1);
        }
    }

    openScene(index){
        this.getActiveScene().exit();
        this.activeSceneIndex = index;
    }
}